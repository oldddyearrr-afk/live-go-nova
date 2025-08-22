from flask import Flask, Response, request
import requests

app = Flask(__name__)

# الهيدرز (ممكن تعدلها حسب الحاجة)
HEADERS = {
    "User-Agent": "VLC/3.0.18 LibVLC/3.0.18",
    "Accept": "*/*",
    "Connection": "keep-alive",
}

@app.route("/play")
def play():
    url = request.args.get("url")
    if not url:
        return "❌ لازم تحط الرابط كـ ?url=...", 400

    try:
        resp = requests.get(url, headers=HEADERS, stream=True, timeout=10)
    except requests.exceptions.RequestException as e:
        return f"خطأ في جلب الرابط: {e}", 500

    # إذا الرابط m3u8 → غير الكونتنت تايب
    if url.endswith(".m3u8"):
        return Response(
            resp.content,
            content_type="application/vnd.apple.mpegurl"
        )

    # غير كذا (ts أو mp4 ... إلخ) → اعتبره فيديو
    return Response(
        resp.iter_content(chunk_size=10240),
        content_type="video/mp2t"
    )

@app.route("/")
def index():
    return """
    <html>
    <head><title>Dynamic Stream Proxy</title></head>
    <body>
        <h2>🎥 بث مباشر عبر البروكسي</h2>
        <form method="get" action="/play">
            <input type="text" name="url" placeholder="ضع رابط TS أو M3U8 هنا" size="80"/>
            <button type="submit">تشغيل</button>
        </form>
        <p>مثال:</p>
        <ul>
            <li><a href="/play?url=https://mo3ad.xyz/live/zaKSyJYcFV/HX9a54WcE3/669.ts" target="_blank">رابط TS مباشر</a></li>
            <li><a href="/play?url=http://example.com/live/playlist.m3u8" target="_blank">رابط M3U8 مباشر</a></li>
        </ul>
    </body>
    </html>
    """

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080, threaded=True)
