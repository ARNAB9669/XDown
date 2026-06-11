# Xstream (ORBITAL INTERCEPT SYSTEM)

Xstream (also known as XDown) is a powerful, self-hosted web application that allows users to securely extract, download, and stream videos natively in the browser from platforms like YouTube. It features a custom-built orbital neon UI, intelligent HTTP proxying for flawless stream scrubbing, and Puppeteer fallbacks for robust extraction.

## 🛠️ Built With

<p align="center">
  <img src="https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white" alt="HTML5" />
  <img src="https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white" alt="CSS3" />
  <img src="https://img.shields.io/badge/JavaScript-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black" alt="JavaScript" />
  <img src="https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Express.js-404D59?style=for-the-badge&logo=express&logoColor=white" alt="Express.js" />
  <img src="https://img.shields.io/badge/FFmpeg-007808?style=for-the-badge&logo=ffmpeg&logoColor=white" alt="FFmpeg" />
  <img src="https://img.shields.io/badge/Puppeteer-40B5A4?style=for-the-badge&logo=puppeteer&logoColor=white" alt="Puppeteer" />
  <img src="https://img.shields.io/badge/yt--dlp-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="yt-dlp" />
</p>

## ✨ Features

- **Direct Downloads:** Download videos and audio directly to your machine using `yt-dlp`.
- **In-Browser Streaming:** Stream directly within the custom UI without downloading.
- **Flawless Scrubbing:** Uses native HTTP proxying for combined A/V streams, allowing instant play, continuous buffering, and native video scrubbing.
- **Custom Format Selection:** Need 1080p? Select specific video and audio formats and the backend will seamlessly mux them on the fly using FFmpeg.
- **Puppeteer Fallback:** If API extraction fails, Xstream spins up a stealth, headless browser instance to manually grab the media chunks.
- **Immersive UI:** A slick, orbital-intercept themed frontend built with vanilla HTML/CSS/JS. No heavy UI frameworks.

## 🚀 Getting Started

Follow these steps to run Xstream locally on your machine.

### Prerequisites

You will need the following installed on your machine:
1. **Node.js** (v18 or higher)
2. **FFmpeg** (installed globally and added to your system PATH)
3. **yt-dlp** (installed globally and added to your system PATH)
   > *Note: Alternatively, you can place the `ffmpeg` and `yt-dlp` executables in a `bin/` folder inside the `backend/` directory.*

### Installation

1. **Clone the repository**
   ```bash
   git clone https://github.com/ARNAB9669/XDown.git
   cd XDown
   ```

2. **Install Backend Dependencies**
   Navigate to the backend directory and install the necessary Node modules:
   ```bash
   cd backend
   npm install
   ```

3. **Start the Server**
   Start the Node.js Express server:
   ```bash
   node server.js
   ```
   *You should see a "XDown Backend Initialized" message in your terminal indicating the server is running on port `8000`.*

4. **Launch the UI**
   Open the `index.html` file in the root directory directly in your favorite web browser. 
   *(Optionally, use an extension like Live Server in VS Code).*

## 🎮 How to Use

1. Paste a valid video URL (e.g., a YouTube link) into the input box.
2. Hit `Enter` or click the **Launch** icon to analyze the link.
3. The server will intercept the URL and provide available streaming and download formats.
4. **Stream**: Click the Stream button to instantly watch the video in the custom player.
5. **Download**: Click the Download button to pipe the raw file directly to your local file system.

## 📝 License

This project is intended for personal and educational use. Please ensure you comply with the Terms of Service of any platforms you extract media from.
