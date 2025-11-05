const TelegramBot = require('node-telegram-bot-api');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    STREAM_URL: 'http://g.rosexz.xyz/at/sh/805768?token=SxAKVEBaQ14XUwYBBVYCD1VdBQRSB1cABAAEUVoFBw4JC1ADBQZUAVQTHBNGEEFcBQhpWAASCFcBAABTFUQTR0NXEGpaVkNeFwUHBgxVBAxGSRRFDV1XQA8ABlQKUFcFCAdXGRFCCAAXC15EWQgfGwEdQlQWXlMOalVUElAFAxQKXBdZXx5DC1tuVFRYBV1dRl8UAEYcEAtGQRNeVxMKWhwQAFxHQAAQUBMKX0AIXxVGBllECkRAGxcLEy1oREoUVUoWUF1BCAtbEwoTQRcRFUYMRW4WVUEWR1RQCVwURAwSAkAZEV8AHGpSX19bAVBNDQpYQkYKEFMXHRMJVggPQl9APUVaVkNeW0RcXUg',
    WATERMARK_TEXT: 't.me/xl9rr',
    SEGMENT_DURATION: 17,
    MAX_DURATION: 40,
    TEMP_DIR: './temp',
    PORT: process.env.PORT || 3000
};

// Check for BOT_TOKEN
if (!CONFIG.BOT_TOKEN) {
    console.error('[ERROR] BOT_TOKEN not found in environment variables');
    console.error('[ERROR] Please add BOT_TOKEN in Secrets settings');
    process.exit(1);
}

// Bot state
const state = {
    isRecording: false,
    users: new Set(),
    currentProcess: null,
    segmentCount: 0
};

// Initialize Telegram bot
const bot = new TelegramBot(CONFIG.BOT_TOKEN, { polling: true });

// Create temp directory and clean old files
function initTempDir() {
    if (!fs.existsSync(CONFIG.TEMP_DIR)) {
        fs.mkdirSync(CONFIG.TEMP_DIR, { recursive: true });
    } else {
        // حذف جميع المقاطع القديمة
        const files = fs.readdirSync(CONFIG.TEMP_DIR);
        let deletedCount = 0;
        
        files.forEach(file => {
            try {
                const filePath = path.join(CONFIG.TEMP_DIR, file);
                fs.unlinkSync(filePath);
                deletedCount++;
            } catch (err) {
                console.error(`[CLEANUP] Failed to delete ${file}: ${err.message}`);
            }
        });
        
        if (deletedCount > 0) {
            console.log(`[CLEANUP] Deleted ${deletedCount} old video file(s)`);
        }
    }
}

// Create scrolling watermark filter
function createScrollingWatermark() {
    return [
        {
            filter: 'drawtext',
            options: {
                text: CONFIG.WATERMARK_TEXT,
                fontsize: 30,
                fontcolor: 'white@0.85',
                shadowcolor: 'black@0.3',
                shadowx: 1,
                shadowy: 1,
                y: 'h-th-40',
                x: 'w - mod(t*120, w+tw)'
            }
        }
    ];
}

// Record single segment with overlap
function recordSegment(startOffset = 0) {
    return new Promise((resolve, reject) => {
        const timestamp = Date.now();
        const outputFile = path.join(CONFIG.TEMP_DIR, `output_${timestamp}.mp4`);
        
        const actualDuration = CONFIG.SEGMENT_DURATION + 3;
        
        console.log(`[REC] Starting ${CONFIG.SEGMENT_DURATION}s segment (${actualDuration}s total with overlap)...`);
        
        const recorder = ffmpeg(CONFIG.STREAM_URL)
            .inputOptions([
                '-t', actualDuration.toString(),
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5'
            ])
            .videoFilters(createScrollingWatermark())
            .outputOptions([
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-crf', '26',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-movflags', '+faststart'
            ])
            .on('start', (cmd) => {
                console.log('[FFMPEG] Processing started');
            })
            .on('progress', (progress) => {
                if (progress.timemark) {
                    process.stdout.write(`\r[PROGRESS] ${progress.timemark} / ${actualDuration}s`);
                }
            })
            .on('error', (err) => {
                console.error(`\n[ERROR] Recording failed: ${err.message}`);
                cleanup(outputFile);
                reject(err);
            })
            .on('end', () => {
                console.log('\n[SUCCESS] Recording completed');
                resolve(outputFile);
            })
            .save(outputFile);
        
        state.currentProcess = recorder;
    });
}

// Send video to users
async function sendVideoToUsers(videoPath) {
    const fileSize = fs.statSync(videoPath).size;
    const sizeMB = (fileSize / 1024 / 1024).toFixed(2);
    
    console.log(`[SEND] Sending video (${sizeMB}MB)...`);
    
    if (fileSize > 50 * 1024 * 1024) {
        console.log('[WARN] File >50MB, compressing...');
        videoPath = await compressVideo(videoPath);
    }
    
    for (const userId of state.users) {
        try {
            await bot.sendVideo(userId, videoPath, {
                caption: 
                    `🎬 *مقطع من البث المباشر*\n\n` +
                    `📊 المقطع: #${state.segmentCount}\n` +
                    `⏱️ المدة: ${CONFIG.SEGMENT_DURATION} ثانية\n` +
                    `📅 التاريخ: ${new Date().toLocaleString('ar-EG')}\n` +
                    `💾 الحجم: ${sizeMB}MB`,
                parse_mode: 'Markdown',
                supports_streaming: true
            });
            console.log(`[SUCCESS] Sent to user: ${userId}`);
        } catch (error) {
            console.error(`[ERROR] Failed to send to ${userId}: ${error.message}`);
        }
    }
    
    cleanup(videoPath);
}

// Compress video
function compressVideo(inputFile) {
    return new Promise((resolve, reject) => {
        const outputFile = inputFile.replace('.mp4', '_compressed.mp4');
        
        console.log('[COMPRESS] Compressing video...');
        
        ffmpeg(inputFile)
            .outputOptions([
                '-c:v', 'libx264',
                '-crf', '30',
                '-preset', 'faster',
                '-vf', 'scale=iw*0.9:ih*0.9',
                '-c:a', 'aac',
                '-b:a', '96k'
            ])
            .on('progress', (progress) => {
                if (progress.percent) {
                    process.stdout.write(`\r[COMPRESS] ${Math.round(progress.percent)}%`);
                }
            })
            .on('error', reject)
            .on('end', () => {
                console.log('\n[SUCCESS] Compression completed');
                fs.unlinkSync(inputFile);
                resolve(outputFile);
            })
            .save(outputFile);
    });
}

// Cleanup files
function cleanup(...files) {
    files.forEach(file => {
        try {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        } catch (err) {
            console.error(`[ERROR] Cleanup failed: ${err.message}`);
        }
    });
}

// Recording loop with overlapping segments
async function recordingLoop() {
    let nextRecordingPromise = null;
    
    while (state.isRecording) {
        try {
            state.segmentCount++;
            const startTime = state.segmentCount === 1 ? 0 : (state.segmentCount - 1) * CONFIG.SEGMENT_DURATION;
            const endTime = startTime + CONFIG.SEGMENT_DURATION;
            
            console.log(`\n${'='.repeat(50)}`);
            console.log(`⏺️ تسجيل #${state.segmentCount} [${startTime}ث → ${endTime}ث]`);
            console.log(`${'='.repeat(50)}\n`);
            
            if (nextRecordingPromise) {
                const videoFile = await nextRecordingPromise;
                
                if (state.isRecording) {
                    nextRecordingPromise = recordSegment();
                    
                    if (state.users.size > 0) {
                        await sendVideoToUsers(videoFile);
                    } else {
                        cleanup(videoFile);
                    }
                } else {
                    cleanup(videoFile);
                }
            } else {
                nextRecordingPromise = recordSegment();
            }
            
            if (global.gc) global.gc();
            
        } catch (error) {
            console.error(`[ERROR] Recording loop: ${error.message}`);
            nextRecordingPromise = null;
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    
    if (nextRecordingPromise) {
        try {
            const videoFile = await nextRecordingPromise;
            cleanup(videoFile);
        } catch (err) {
            console.error(`[ERROR] Final cleanup: ${err.message}`);
        }
    }
    
    console.log('[STOP] Recording loop stopped');
}

// Start recording
function startRecording() {
    if (state.isRecording) return false;
    
    state.isRecording = true;
    state.segmentCount = 0;
    console.log('[START] Recording started');
    
    recordingLoop().catch(err => {
        console.error(`[FATAL] ${err}`);
        stopRecording();
    });
    
    return true;
}

// Stop recording
function stopRecording() {
    state.isRecording = false;
    
    if (state.currentProcess) {
        state.currentProcess.kill('SIGKILL');
        state.currentProcess = null;
    }
    
    console.log('[STOP] Recording stopped');
    return true;
}

// ========================================
// Telegram Bot Commands
// ========================================

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
                { text: '📊 الحالة', callback_data: 'status' },
                { text: '⚙️ الإعدادات', callback_data: 'settings' }
            ],
            [{ text: '❓ المساعدة', callback_data: 'help' }]
        ]
    };
    
    bot.sendMessage(chatId, 
        `🎬 *بوت تسجيل البث المباشر*\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `✨ *المميزات:*\n` +
        `• 🎥 جودة عالية للفيديو والصوت\n` +
        `• 💫 علامة مائية متحركة احترافية\n` +
        `• ⚡ إرسال تلقائي\n` +
        `• 🎯 مدة قابلة للتخصيص (${CONFIG.SEGMENT_DURATION} ثانية)\n\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🚀 جاهز للتسجيل!`,
        { reply_markup: keyboard, parse_mode: 'Markdown' }
    );
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    
    await bot.answerCallbackQuery(query.id);
    
    switch (query.data) {
        case 'start_rec':
            if (startRecording()) {
                bot.sendMessage(chatId, 
                    `✅ *تم بدء التسجيل!*\n\n` +
                    `⏱️ المدة: ${CONFIG.SEGMENT_DURATION} ثانية لكل مقطع\n` +
                    `💧 العلامة المائية: ${CONFIG.WATERMARK_TEXT}\n` +
                    `📤 الإرسال التلقائي مفعّل`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                bot.sendMessage(chatId, '⚠️ التسجيل يعمل بالفعل!');
            }
            break;
            
        case 'stop_rec':
            if (stopRecording()) {
                bot.sendMessage(chatId, 
                    `⏹️ *تم إيقاف التسجيل*\n\n` +
                    `📊 إجمالي المقاطع: ${state.segmentCount}`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                bot.sendMessage(chatId, '⚠️ التسجيل متوقف بالفعل');
            }
            break;
            
        case 'status':
            const status = state.isRecording ? '🔴 يعمل' : '⚪ متوقف';
            const memory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
            
            bot.sendMessage(chatId,
                `📊 *حالة البوت*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `الحالة: ${status}\n` +
                `المقاطع: ${state.segmentCount}\n` +
                `المستخدمين النشطين: ${state.users.size}\n` +
                `الذاكرة: ${memory}MB / 512MB\n\n` +
                `⚙️ *الإعدادات الحالية:*\n` +
                `• المدة: ${CONFIG.SEGMENT_DURATION} ثانية\n` +
                `• العلامة المائية: ${CONFIG.WATERMARK_TEXT}\n` +
                `• الحد الأقصى: ${CONFIG.MAX_DURATION} ثانية`,
                { parse_mode: 'Markdown' }
            );
            break;
            
        case 'settings':
            bot.sendMessage(chatId,
                `⚙️ *الإعدادات*\n\n` +
                `استخدم هذه الأوامر:\n\n` +
                `• \`/duration 17\` - تغيير المدة (5-${CONFIG.MAX_DURATION} ثانية)\n` +
                `• \`/watermark نص\` - تغيير العلامة المائية\n\n` +
                `💡 *ملاحظة:* أوقف التسجيل قبل تغيير الإعدادات`,
                { parse_mode: 'Markdown' }
            );
            break;
            
        case 'help':
            bot.sendMessage(chatId,
                `❓ *المساعدة*\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `*الأوامر المتاحة:*\n\n` +
                `• \`/start\` - تشغيل البوت\n` +
                `• \`/duration <ثواني>\` - تحديد مدة المقطع\n` +
                `• \`/watermark <نص>\` - تحديد نص العلامة المائية\n` +
                `• \`/status\` - عرض الحالة\n\n` +
                `*أمثلة:*\n` +
                `• \`/duration 20\` - مقاطع 20 ثانية\n` +
                `• \`/watermark X.com/mychannel\`\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `💬 الدعم: @YourSupport`,
                { parse_mode: 'Markdown' }
            );
            break;
    }
});

// Change duration
bot.onText(/\/duration (\d+)/, (msg, match) => {
    if (state.isRecording) {
        bot.sendMessage(msg.chat.id, '⚠️ أوقف التسجيل أولاً!');
        return;
    }
    
    const duration = parseInt(match[1]);
    
    if (duration < 5) {
        bot.sendMessage(msg.chat.id, '⚠️ المدة يجب أن تكون 5 ثوانٍ على الأقل');
        return;
    }
    
    if (duration > CONFIG.MAX_DURATION) {
        bot.sendMessage(msg.chat.id, 
            `⚠️ الحد الأقصى للمدة: ${CONFIG.MAX_DURATION} ثانية`
        );
        return;
    }
    
    CONFIG.SEGMENT_DURATION = duration;
    bot.sendMessage(msg.chat.id, 
        `✅ تم تعيين المدة إلى: *${duration} ثانية*`,
        { parse_mode: 'Markdown' }
    );
});

// Change watermark
bot.onText(/\/watermark (.+)/, (msg, match) => {
    if (state.isRecording) {
        bot.sendMessage(msg.chat.id, '⚠️ أوقف التسجيل أولاً!');
        return;
    }
    
    CONFIG.WATERMARK_TEXT = match[1].trim();
    bot.sendMessage(msg.chat.id, 
        `✅ تم تعيين العلامة المائية إلى:\n\`${CONFIG.WATERMARK_TEXT}\``,
        { parse_mode: 'Markdown' }
    );
});

// Show status
bot.onText(/\/status/, (msg) => {
    const status = state.isRecording ? '🔴 يعمل' : '⚪ متوقف';
    const memory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    
    bot.sendMessage(msg.chat.id,
        `📊 *الحالة:* ${status}\n` +
        `📹 *المقاطع:* ${state.segmentCount}\n` +
        `💾 *الذاكرة:* ${memory}MB\n` +
        `⏱️ *المدة:* ${CONFIG.SEGMENT_DURATION} ثانية`,
        { parse_mode: 'Markdown' }
    );
});

// ========================================
// Start Bot
// ========================================

async function main() {
    initTempDir();
    
    console.log('╔════════════════════════════════════════╗');
    console.log('║   Stream Recorder Bot                ║');
    console.log('╚════════════════════════════════════════╝');
    console.log('');
    console.log(`[OK] Bot ready`);
    console.log(`[MEM] ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
    console.log(`[DUR] Default duration: ${CONFIG.SEGMENT_DURATION}s`);
    console.log(`[WM] Watermark: ${CONFIG.WATERMARK_TEXT}`);
    console.log('');
    
    const express = require('express');
    const app = express();
    
    app.get('/', (req, res) => {
        res.json({
            bot: 'Stream Recorder Bot',
            status: 'online',
            recording: state.isRecording,
            segments: state.segmentCount,
            users: state.users.size
        });
    });
    
    app.get('/health', (req, res) => {
        res.json({ 
            status: 'healthy',
            memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            uptime: process.uptime()
        });
    });
    
    app.listen(CONFIG.PORT, () => {
        console.log(`[SERVER] Running on port ${CONFIG.PORT}`);
    });
}

// Error handling
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT]', err);
});

process.on('unhandledRejection', (err) => {
    console.error('[UNHANDLED]', err);
});

process.on('SIGTERM', () => {
    console.log('\n[SHUTDOWN] SIGTERM received');
    stopRecording();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] SIGINT received');
    stopRecording();
    process.exit(0);
});

main();
