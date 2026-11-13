const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const vendorDir = path.join(__dirname, 'vendor');
const webfontsDir = path.join(vendorDir, 'webfonts');

fs.mkdirSync(webfontsDir, { recursive: true });

const files = [
  { url: 'https://cdn.tailwindcss.com/3.4.15', dest: path.join(vendorDir, 'tailwind.js') },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', dest: path.join(vendorDir, 'pdf.min.js') },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', dest: path.join(vendorDir, 'pdf.worker.min.js') },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', dest: path.join(vendorDir, 'jspdf.umd.min.js') },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css', dest: path.join(vendorDir, 'fontawesome.min.css') },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.woff2', dest: path.join(webfontsDir, 'fa-solid-900.woff2') },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-regular-400.woff2', dest: path.join(webfontsDir, 'fa-regular-400.woff2') },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-brands-400.woff2', dest: path.join(webfontsDir, 'fa-brands-400.woff2') },
  { url: 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/webfonts/fa-solid-900.ttf', dest: path.join(webfontsDir, 'fa-solid-900.ttf') }
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const request = (currentUrl) => {
      https.get(currentUrl, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          return request(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error('Failed ' + currentUrl + ': ' + res.statusCode));
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      }).on('error', reject);
    };
    request(url);
  });
}

(async () => {
  console.log('⏳ جاري تنزيل المكتبات محلياً...');
  for (const f of files) {
    console.log('⬇️ تنزيل:', path.basename(f.dest));
    await download(f.url, f.dest);
  }
  console.log('✅ تم التنزيل بنجاح!');
})();