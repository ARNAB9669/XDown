# Xstream (Orbital Intercept System)

Xstream (also known as XDown) is a self-hosted web application that allows users to securely extract, download, and stream videos natively in the browser from platforms like You know. 

## Built With

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

## Features

- **Direct Downloads:** Download videos and audio directly to your machine using `yt-dlp`.
- **In-Browser Streaming:** Stream directly within the custom UI without downloading.
- **Flawless Scrubbing:** Uses native HTTP proxying for combined A/V streams, allowing instant play, continuous buffering, and native video scrubbing.
- **Steganography Bypass:** Intelligently detects and strips fake PNG headers from obfuscated video chunks (often used by CDNs like TikTok) on-the-fly, passing clean MPEG-TS streams to FFmpeg.
- **Custom Format Selection:** Select specific video and audio formats and the backend will seamlessly mux them on the fly using FFmpeg.
- **Puppeteer Fallback:** If API extraction fails, Xstream spins up a stealth, headless browser instance to manually grab the media chunks.
- **Immersive UI:** A modern, orbital-intercept themed frontend built with vanilla HTML/CSS/JS. No heavy UI frameworks.

## Getting Started

Follow these steps to run Xstream locally on your machine.

### Prerequisites

You will need the following installed on your machine:
1. **Node.js** (v18 or higher)
2. **FFmpeg** and **yt-dlp**
   > **Note:** You can install these globally on your system (e.g. via Homebrew), OR you can place the executables/wrapper scripts directly into a `backend/bin/` folder. The application will automatically detect them there.

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
   npm start
   ```
   *You should see an "XDown Backend Initialized" message in your terminal indicating the server is running on port `8000`.*

4. **Launch the UI**
   Open the `index.html` file in the root directory directly in your preferred web browser. 
   *(Optionally, use an extension like Live Server in VS Code).*

## Usage Guide

1. Paste a valid video URL (e.g., a YouTube link) into the input box.
2. Press `Enter` or click the Launch icon to analyze the link.
3. The server will intercept the URL and provide available streaming and download formats.
4. **Stream**: Click the Stream button to instantly watch the video in the custom player.
5. **Download**: Click the Download button to pipe the raw file directly to your local file system.

## Known Issues & Troubleshooting

**Downloaded MP4 file shows a 5-second duration in macOS QuickTime:**
Because Xstream pipes live downloads instantly to your browser to minimize wait times, it utilizes a **Fragmented MP4** stream. macOS QuickTime and Finder may have difficulty reading the global duration of fragmented files and will often display the duration of the first 5-second chunk. 
* **Workaround 1**: Open the file in VLC, IINA, or Google Chrome. It will play the full duration perfectly.
* **Workaround 2**: If you require it to work natively in QuickTime, rebuild the MP4 header by running:
  ```bash
  ffmpeg -i downloaded_video.mp4 -c copy FixedVideo.mp4
  ```
  *(If QuickTime complains about the audio track missing, use `-c:a aac` instead of `-c copy` to enforce strict AAC compliance).*

## License

This project is intended for personal and educational use. Please ensure you comply with the Terms of Service of any platforms you extract media from.
