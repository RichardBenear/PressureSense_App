// PressureSense photo gallery -- simple, static, data-driven. No WebSocket,
// no server round trip; just this array rendered into a responsive grid.
//
// To add a photo:
//   1. Drop the full-resolution original in the repo-root photos/ folder
//      (git-ignored -- source library, not deployed).
//   2. Resize/compress a web copy into public/photos/ (this is what actually
//      gets served -- originals straight off a phone are typically 2-4MB at
//      4000px+, way too heavy for a mobile page):
//        magick photos/<name>.jpeg -auto-orient -resize 1600x1600 -quality 82 -strip public/photos/<name>.jpeg
//   3. Add a { file, description } entry below.
const PHOTOS = [
  { file: 'IMG_4394.jpeg', description: 'Indoor Unit - Map Page' },
  { file: 'IMG_4396.jpeg', description: 'Indoor Unit - Chart Page' },
];

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderPhotos() {
  const grid = document.getElementById('photo-grid');
  if (!PHOTOS.length) {
    grid.innerHTML = '<div class="ag-help-text" style="padding:16px;">No photos yet.</div>';
  } else {
    grid.innerHTML = PHOTOS.map(p => `
      <div class="ag-photo-card">
        <a href="photos/${encodeURIComponent(p.file)}" target="_blank" rel="noopener">
          <img class="ag-photo-img" src="photos/${encodeURIComponent(p.file)}" alt="${escapeHtml(p.description)}" loading="lazy">
        </a>
        <div class="ag-photo-desc">${escapeHtml(p.description)}</div>
      </div>`).join('');
  }
  const countEl = document.getElementById('footer-photo-count');
  if (countEl) countEl.textContent = PHOTOS.length + (PHOTOS.length === 1 ? ' PHOTO' : ' PHOTOS');
}

document.addEventListener('DOMContentLoaded', renderPhotos);
