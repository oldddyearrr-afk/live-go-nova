const TelegramBot = require('node-telegram-bot-api');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const unlinkAsync = promisify(fs.unlink);

// Configuration
const CONFIG = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    STREAM_URL: 'http://g.rosexz.xyz/at/sh/805768?token=SxAKVEBaQ14XUwYBBVYCD1VdBQRSB1cABAAEUVoFBw4JC1ADBQZUAVQTHBNGEEFcBQhpWAASCFcBAABTFUQTR0NXEGpaVkNeFwUHBgxVBAxGSRRFDV1XQA8ABlQKUFcFCAdXGRFCCAAXC15EWQgfGwEdQlQWXlMOalVUElAFAxQKXBdZXx5DC1tuVFRYBV1dRl8UAEYcEAtGQRNeVxMKWhwQAFxHQAAQUBMKX0AIXxVGBllECkRAGxcLEy1oREoUVUoWUF1BCAtbEwoTQRcRFUYMRW4WVUEWR1RQCVwURAwSAkAZEV8AHGpSX19bAVBNDQpYQkYKEFMXHRMJVggPQl9APUVaVkNeW0RcXUg',
    WATERMARK_TEXT: 't.me/xl9rr',
    SEGMENT_DURATION: 15, // قللته من 17 لتقليل الحمل
    MAX_DURATION: 30,     // قللته من 40
    TEMP_DIR: './temp',
    PORT: process.env.PORT || 3000,
    MAX_FILE_SIZE: 45 * 1024 * 1024, // 45MB حد أقصى
    // تحسينات الذاكرة
    MAX_CONCURRENT_PROCESSES: 1,
    CLEANUP_INTERVAL: 20000, // تنظيف كل 30 ثانية
    MEMORY_LIMIT: 450 * 1024 * 1024 // 450MB حد أقصى
};

// Check BOT_TOKEN
if (!CONFIG.BOT_TOKEN) {
    console.error('[ERROR] BOT_TOKEN not found!');
    process.exit(1);
}

// Bot state
const state = {
    isRecording: false,
    users: new Set(),
    currentProcess: null,
    segmentCount: 0,
    processingQueue: [],
    isProcessing: false
};

// Initialize bot
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { 
    polling: {
        interval: 1000,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

// ============================================
// تحسينات الذاكرة
// ============================================

// مراقبة الذاكرة
function checkMemory() {
    const usage = process.memoryUsage();
    const heapUsed = usage.heapUsed;
    const heapPercent = (heapUsed / CONFIG.MEMORY_LIMIT * 100).toFixed(1);
    
    if (heapUsed > CONFIG.MEMORY_LIMIT) {
        console.warn(`[MEMORY] ⚠️ High memory: ${(heapUsed/1024/1024).toFixed(0)}MB (${heapPercent}%)`);
        
        // إيقاف التسجيل إذا تجاوزت الذاكرة الحد
        if (state.isRecording && heapPercent > 95) {
            console.error('[MEMORY] 🚨 Memory critical! Stopping recording...');
            stopRecording();
            cleanupAllFiles();
        }
        
        // تنظيف قوي
        if (global.gc) {
            global.gc();
            console.log('[GC] Garbage collection triggered');
        }
    }
    
    return { heapUsed, heapPercent };
}

// تنظيف دوري
setInterval(() => {
    checkMemory();
    cleanupOldFiles();
}, CONFIG.CLEANUP_INTERVAL);

// Create temp directory
function initTempDir() {
    if (!fs.existsSync(CONFIG.TEMP_DIR)) {
        fs.mkdirSync(CONFIG.TEMP_DIR, { recursive: true });
    }
    cleanupAllFiles();
}

// تنظيف جميع الملفات
function cleanupAllFiles() {
    try {
        const files = fs.readdirSync(CONFIG.TEMP_DIR);
        let deleted = 0;
        
        files.forEach(file => {
            try {
                const filePath = path.join(CONFIG.TEMP_DIR, file);
                fs.unlinkSync(filePath);
                deleted++;
            } catch (err) {
                console.error(`[CLEANUP] Failed: ${file}`);
            }
        });
        
        if (deleted > 0) {
            console.log(`[CLEANUP] 🗑️ Deleted ${deleted} file(s)`);
        }
    } catch (err) {
        console.error('[CLEANUP] Error:', err.message);
    }
}

// تنظيف الملفات القديمة (أكثر من 5 دقائق)
function cleanupOldFiles() {
    try {
        const files = fs.readdirSync(CONFIG.TEMP_DIR);
        const now = Date.now();
        let deleted = 0;
        
        files.forEach(file => {
            try {
                const filePath = path.join(CONFIG.TEMP_DIR, file);
                const stats = fs.statSync(filePath);
                const age = now - stats.mtimeMs;
                
                // احذف الملفات الأقدم من 5 دقائق
                if (age > 5 * 60 * 1000) {
                    fs.unlinkSync(filePath);
                    deleted++;
                }
            } catch (err) {
                // تجاهل الأخطاء
            }
        });
        
        if (deleted > 0) {
            console.log(`[CLEANUP] 🗑️ Deleted ${deleted} old file(s)`);
        }
    } catch (err) {
        // تجاهل أخطاء القراءة
    }
}

// Watermark filter (محسّن)
function createScrollingWatermark() {
    return [
        {
            filter: 'drawtext',
            options: {
                text: CONFIG.WATERMARK_TEXT,
                fontsize: 28,
                fontcolor: 'white@0.8',
                shadowcolor: 'black@0.5',
                shadowx: 2,
                shadowy: 2,
                y: 'h-th-30',
                x: 'w - mod(t*100, w+tw)'
            }
        }
    ];
}

// تسجيل محسّن
function recordSegment() {
    return new Promise((resolve, reject) => {
        const timestamp = Date.now();
        const outputFile = path.join(CONFIG.TEMP_DIR, `vid_${timestamp}.mp4`);
        
        console.log(`[REC] 🎬 Starting ${CONFIG.SEGMENT_DURATION}s segment...`);
        
        const recorder = ffmpeg(CONFIG.STREAM_URL)
            .inputOptions([
                '-t', CONFIG.SEGMENT_DURATION.toString(),
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '3',
                '-analyzeduration', '2000000',
                '-probesize', '2000000'
            ])
            .videoFilters(createScrollingWatermark())
            .outputOptions([
                '-c:v', 'libx264',
                '-preset', 'fast',      // جودة أفضل مع سرعة معقولة
                '-crf', '23',           // جودة عالية (23 أفضل من 28)
                '-maxrate', '1.5M',     // زيادة قليلة في البيترات
                '-bufsize', '3M',
                '-c:a', 'aac',
                '-b:a', '128k',         // جودة صوت أفضل
                '-ac', '2',
                '-ar', '48000',         // تحسين جودة الصوت
                '-movflags', '+faststart',
                '-map', '0:v:0',
                '-map', '0:a:0',
                '-profile:v', 'high',   // بروفايل عالي للجودة
                '-level', '4.0'
            ])
            .on('start', (cmd) => {
                console.log('[FFMPEG] ▶️ Started');
            })
            .on('progress', (progress) => {
                if (progress.timemark) {
                    const mem = checkMemory();
                    process.stdout.write(
                        `\r[PROGRESS] ${progress.timemark}/${CONFIG.SEGMENT_DURATION}s | ` +
                        `MEM: ${(mem.heapUsed/1024/1024).toFixed(0)}MB (${mem.heapPercent}%)`
                    );
                }
            })
            .on('error', (err) => {
                console.error(`\n[ERROR] ❌ Recording failed: ${err.message}`);
                cleanup(outputFile);
                reject(err);
            })
            .on('end', () => {
                console.log('\n[SUCCESS] ✅ Recording completed');
                
                // تحقق من حجم الملف
                const stats = fs.statSync(outputFile);
                const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
                console.log(`[FILE] 📁 Size: ${sizeMB}MB`);
                
                resolve(outputFile);
            })
            .save(outputFile);
        
        state.currentProcess = recorder;
    });
}

// إرسال محسّن مع معالجة الأخطاء
async function sendVideoToUsers(videoPath) {
    console.log(`\n[SEND] 📤 Sending to ${state.users.size} user(s)...`);
    
    if (state.users.size === 0) {
        console.log('[WARN] ⚠️ No users subscribed!');
        cleanup(videoPath);
        return;
    }
    
    if (!fs.existsSync(videoPath)) {
        console.error('[ERROR] ❌ File not found!');
        return;
    }
    
    const fileStats = fs.statSync(videoPath);
    const sizeMB = (fileStats.size / 1024 / 1024).toFixed(2);
    
    // ضغط إذا كان أكبر من 45MB
    if (fileStats.size > CONFIG.MAX_FILE_SIZE) {
        console.log(`[COMPRESS] 🔄 File too large (${sizeMB}MB), compressing...`);
        try {
            videoPath = await compressVideo(videoPath);
        } catch (err) {
            console.error('[ERROR] ❌ Compression failed:', err.message);
            cleanup(videoPath);
            return;
        }
    }
    
    let success = 0;
    let failed = 0;
    
    for (const userId of state.users) {
        try {
            await bot.sendVideo(userId, videoPath, {
                caption: 
                    `🎬 مقطع #${state.segmentCount}\n` +
                    `⏱️ ${CONFIG.SEGMENT_DURATION}s | 💾 ${sizeMB}MB\n` +
                    `📅 ${new Date().toLocaleTimeString('ar-EG')}`,
                supports_streaming: true,
                disable_notification: true
            });
            
            success++;
            console.log(`[SEND] ✅ Sent to ${userId}`);
            
            // تأخير صغير لتجنب Rate Limit
            await new Promise(resolve => setTimeout(resolve, 100));
            
        } catch (error) {
            failed++;
            console.error(`[SEND] ❌ Failed ${userId}: ${error.message}`);
            
            // إزالة المستخدمين المحظورين
            if (error.message.includes('bot was blocked')) {
                state.users.delete(userId);
                console.log(`[USER] 🚫 Removed blocked user: ${userId}`);
            }
        }
    }
    
    console.log(`[SEND] ✅ ${success} | ❌ ${failed}\n`);
    
    // حذف فوري
    cleanup(videoPath);
    
    // تنظيف الذاكرة
    if (global.gc) global.gc();
}

// ضغط محسّن
function compressVideo(inputFile) {
    return new Promise((resolve, reject) => {
        const outputFile = inputFile.replace('.mp4', '_c.mp4');
        
        console.log('[COMPRESS] 🔄 Compressing...');
        
        ffmpeg(inputFile)
            .outputOptions([
                '-c:v', 'libx264',
                '-crf', '26',           // ضغط أقل للحفاظ على الجودة
                '-preset', 'medium',    // توازن بين السرعة والجودة
                '-vf', 'scale=iw*0.9:ih*0.9', // تصغير أقل
                '-c:a', 'aac',
                '-b:a', '96k',          // صوت أفضل
                '-ac', '2',             // Stereo
                '-profile:v', 'high',
                '-level', '4.0'
            ])
            .on('progress', (progress) => {
                if (progress.percent) {
                    process.stdout.write(`\r[COMPRESS] ${Math.round(progress.percent)}%`);
                }
            })
            .on('error', (err) => {
                console.error('\n[ERROR] Compression failed:', err.message);
                cleanup(outputFile);
                reject(err);
            })
            .on('end', () => {
                console.log('\n[SUCCESS] ✅ Compressed');
                
                // حذف الملف الأصلي
                cleanup(inputFile);
                
                const newSize = fs.statSync(outputFile).size;
                const sizeMB = (newSize / 1024 / 1024).toFixed(2);
                console.log(`[FILE] 📁 New size: ${sizeMB}MB`);
                
                resolve(outputFile);
            })
            .save(outputFile);
    });
}

// Cleanup
function cleanup(...files) {
    files.forEach(file => {
        try {
            if (file && fs.existsSync(file)) {
                fs.unlinkSync(file);
                console.log(`[CLEANUP] 🗑️ Deleted: ${path.basename(file)}`);
            }
        } catch (err) {
            console.error(`[CLEANUP] ❌ Failed: ${err.message}`);
        }
    });
}

// Recording loop محسّن
async function recordingLoop() {
    console.log('[LOOP] 🔄 Recording loop started');
    
    while (state.isRecording) {
        try {
            // تحقق من الذاكرة قبل التسجيل
            const mem = checkMemory();
            if (parseFloat(mem.heapPercent) > 90) {
                console.warn('[MEMORY] ⚠️ Memory too high, pausing...');
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
            
            state.segmentCount++;
            console.log(`\n${'='.repeat(40)}`);
            console.log(`⏺️ Segment #${state.segmentCount}`);
            console.log(`${'='.repeat(40)}\n`);
            
            // تسجيل
            const videoFile = await recordSegment();
            
            // إرسال فوري
            if (state.isRecording && state.users.size > 0) {
                await sendVideoToUsers(videoFile);
            } else {
                console.log('[INFO] No users or stopped - deleting');
                cleanup(videoFile);
            }
            
            // تنظيف قوي للذاكرة
            if (global.gc) {
                global.gc();
                console.log('[GC] 🧹 Memory cleaned');
            }
            
            // راحة صغيرة بين المقاطع
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            console.error(`[ERROR] ❌ Loop error: ${error.message}`);
            
            // انتظر قبل إعادة المحاولة
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    console.log('[LOOP] ⏹️ Recording loop stopped');
}

// Start/Stop
function startRecording() {
    if (state.isRecording) return false;
    
    // تنظيف قبل البدء
    cleanupAllFiles();
    
    state.isRecording = true;
    state.segmentCount = 0;
    console.log('[START] ▶️ Recording started');
    
    recordingLoop().catch(err => {
        console.error(`[FATAL] ${err.message}`);
        stopRecording();
    });
    
    return true;
}

function stopRecording() {
    state.isRecording = false;
    
    if (state.currentProcess) {
        state.currentProcess.kill('SIGKILL');
        state.currentProcess = null;
    }
    
    // تنظيف شامل
    cleanupAllFiles();
    
    console.log('[STOP] ⏹️ Recording stopped');
    return true;
}

// ============================================
// Telegram Commands
// ============================================

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    state.users.add(chatId);
    
    const keyboard = {
        inline_keyboard: [
            [
                { text: '🔴 تشغيل', callback_data: 'start_rec' },
                { text: '⏹️ إيقاف', callback_data: 'stop_rec' }
            ],
            [
                { text: '📊 الحالة', callback_data: 'status' }
            ]
        ]
    };
    
    bot.sendMessage(chatId, 
        `🎬 *بوت تسجيل البث المباشر*\n\n` +
        `✨ محسّن للعمل على 512MB\n` +
        `⚡ تسجيل تلقائي كل ${CONFIG.SEGMENT_DURATION} ثانية\n` +
        `💫 علامة مائية متحركة\n\n` +
        `🚀 جاهز للاستخدام!`,
        { reply_markup: keyboard, parse_mode: 'Markdown' }
    );
    
    console.log(`[USER] ✅ New user: ${chatId} (Total: ${state.users.size})`);
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    await bot.answerCallbackQuery(query.id);
    
    switch (query.data) {
        case 'start_rec':
            if (startRecording()) {
                bot.sendMessage(chatId, 
                    `✅ *تم بدء التسجيل!*\n\n` +
                    `⏱️ ${CONFIG.SEGMENT_DURATION} ثانية لكل مقطع\n` +
                    `📤 إرسال تلقائي`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                bot.sendMessage(chatId, '⚠️ يعمل بالفعل!');
            }
            break;
            
        case 'stop_rec':
            if (stopRecording()) {
                bot.sendMessage(chatId, 
                    `⏹️ *تم الإيقاف*\n\n` +
                    `📊 المقاطع: ${state.segmentCount}`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                bot.sendMessage(chatId, '⚠️ متوقف بالفعل');
            }
            break;
            
        case 'status':
            const mem = process.memoryUsage();
            const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(0);
            const status = state.isRecording ? '🔴 يعمل' : '⚪ متوقف';
            
            bot.sendMessage(chatId,
                `📊 *حالة البوت*\n\n` +
                `الحالة: ${status}\n` +
                `المقاطع: ${state.segmentCount}\n` +
                `المستخدمين: ${state.users.size}\n` +
                `الذاكرة: ${heapMB}MB / 512MB\n` +
                `المدة: ${CONFIG.SEGMENT_DURATION}s`,
                { parse_mode: 'Markdown' }
            );
            break;
    }
});

// ============================================
// Health Check Server
// ============================================

const express = require('express');
const app = express();

app.get('/', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        bot: 'Stream Recorder',
        status: 'online',
        recording: state.isRecording,
        segments: state.segmentCount,
        users: state.users.size,
        memory: {
            heap: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
            rss: Math.round(mem.rss / 1024 / 1024) + 'MB'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        uptime: Math.floor(process.uptime()) + 's'
    });
});

// ============================================
// Error Handling
// ============================================

process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err);
    stopRecording();
});

process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED]', err);
});

process.on('SIGTERM', () => {
    console.log('\n[SHUTDOWN] SIGTERM');
    stopRecording();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] SIGINT');
    stopRecording();
    process.exit(0);
});

// ============================================
// Start
// ============================================

async function main() {
    initTempDir();
    
    console.log('╔════════════════════════════════════════╗');
    console.log('║   Stream Recorder Bot (Optimized)    ║');
    console.log('╚════════════════════════════════════════╝\n');
    console.log(`[OK] Bot ready`);
    console.log(`[MEM] ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB / 512MB`);
    console.log(`[DUR] ${CONFIG.SEGMENT_DURATION}s per segment`);
    console.log(`[WM] ${CONFIG.WATERMARK_TEXT}\n`);
    
    app.listen(CONFIG.PORT, () => {
        console.log(`[SERVER] 🌐 Running on port ${CONFIG.PORT}\n`);
    });
}

main();
