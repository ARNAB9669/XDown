export function initFixer() {
  const dropzone = document.getElementById('fixer-dropzone');
  const input = document.getElementById('fixer-input');
  const status = document.getElementById('fixer-status');
  const statusText = document.getElementById('fixer-status-text');

  if (!dropzone || !input) return;

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--green)';
    dropzone.style.background = 'rgba(57, 255, 20, 0.15)';
  });

  dropzone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--cyan)';
    dropzone.style.background = 'rgba(0, 212, 255, 0.05)';
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.style.borderColor = 'var(--cyan)';
    dropzone.style.background = 'rgba(0, 212, 255, 0.05)';
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  input.addEventListener('change', (e) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFile(e.target.files[0]);
    }
  });

  async function handleFile(file) {
    if (!file.name.endsWith('.mp4')) {
      alert('Only .mp4 files are supported!');
      return;
    }

    dropzone.style.display = 'none';
    status.style.display = 'block';

    try {
      const response = await fetch(`/api/fix-mp4?filename=${encodeURIComponent(file.name)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: file
      });

      if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
      }

      statusText.innerText = 'FIX COMPLETE! DOWNLOADING...';
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      
      // Get filename from Content-Disposition if available
      let downloadName = file.name.replace('.mp4', '_Fixed.mp4');
      const cd = response.headers.get('Content-Disposition');
      if (cd && cd.includes('filename="')) {
        downloadName = cd.split('filename="')[1].split('"')[0];
      }
      
      a.download = downloadName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      
      setTimeout(() => {
        document.getElementById('fixer-modal').style.display = 'none';
        resetFixer();
      }, 1500);

    } catch (err) {
      console.error(err);
      alert('Failed to fix file: ' + err.message);
      resetFixer();
    }
  }

  function resetFixer() {
    dropzone.style.display = 'block';
    status.style.display = 'none';
    statusText.innerText = 'UPLOADING & REBUILDING (0%)...';
    input.value = '';
  }
}
