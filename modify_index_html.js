const fs = require('fs');

let html = fs.readFileSync('index.html', 'utf8');

// 1. Replace <style> block
const styleStart = html.indexOf('<style>');
const styleEnd = html.indexOf('</style>') + 8;
html = html.substring(0, styleStart) + '<link rel="stylesheet" href="frontend/css/styles.css">' + html.substring(styleEnd);

// 2. We need to extract the CDN script tags that were at the top of the large script block
const scriptStart = html.lastIndexOf('<script>');
const scriptEnd = html.lastIndexOf('</script>') + 9;

// Let's just find the hls and shaka lines before we remove the script block, wait they are BEFORE the big script block in some places?
// Actually in index.html line 2314 and 2315 are:
// <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
// <script src="https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.3.5/shaka-player.ui.min.js"></script>
// <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/shaka-player/4.3.5/controls.min.css">
// Let's just leave those tags where they are, and ONLY replace the <script>...</script> that contains the custom logic.
// The custom logic starts at line 2317 `<script>` and ends at line 4013 `</script>`.

const bigScriptStart = html.indexOf('<script>', html.indexOf('shaka-player.ui.min.js'));
const bigScriptEnd = html.indexOf('</script>', bigScriptStart) + 9;

html = html.substring(0, bigScriptStart) + '<script type="module" src="frontend/js/main.js"></script>' + html.substring(bigScriptEnd);

fs.writeFileSync('index.html', html);
console.log('Modified index.html');
