
import { clearSession } from './session.js';
import { resetDecode } from './decode.js';
import { closeWarp } from './download.js';
import { closeStream } from './stream.js';
import { setVideoInfo } from './state.js';

export function reset() {
  setVideoInfo(null);
  clearSession();
  document.getElementById('url-input').value = '';
  document.getElementById('result-panel').className = '';
  document.getElementById('dl-btn').setAttribute('data-disabled', 'true');
  document.getElementById('stream-btn').setAttribute('data-disabled', 'true');
  resetDecode();
  closeWarp();
  closeStream();
}
