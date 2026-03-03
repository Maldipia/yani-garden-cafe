// Web Worker: handles image resize + base64 encoding fully off the main thread
// Accepts a blobUrl (created with URL.createObjectURL on main thread — zero copy)
// Uses fetch() inside the worker to read the file — fully off the main thread
self.onmessage = function(e) {
  var blobUrl = e.data.blobUrl;
  var MAX = 1200;

  fetch(blobUrl)
    .then(function(r) { return r.blob(); })
    .then(function(blob) { return createImageBitmap(blob); })
    .then(function(bitmap) {
      var w = bitmap.width, h = bitmap.height;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      var canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
    })
    .then(function(jpegBlob) {
      var reader = new FileReaderSync();
      var dataUrl = reader.readAsDataURL(jpegBlob);
      var base64 = dataUrl.split(',')[1];
      self.postMessage({ ok: true, base64: base64 });
    })
    .catch(function(err) {
      self.postMessage({ ok: false, error: err.message });
    });
};
