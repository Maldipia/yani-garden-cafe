// Web Worker: handles canvas resize + base64 encoding off the main thread
// This prevents the Upload button from blocking the UI (INP issue)
self.onmessage = function(e) {
  var arrayBuffer = e.data.arrayBuffer;
  var MAX = 1200;

  // Convert ArrayBuffer to Blob then to ImageBitmap (available in workers)
  var blob = new Blob([arrayBuffer]);
  createImageBitmap(blob).then(function(bitmap) {
    var w = bitmap.width, h = bitmap.height;
    if (w > MAX || h > MAX) {
      if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
      else { w = Math.round(w * MAX / h); h = MAX; }
    }
    var canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 }).then(function(jpegBlob) {
      var reader = new FileReaderSync();
      var dataUrl = reader.readAsDataURL(jpegBlob);
      var base64 = dataUrl.split(',')[1];
      self.postMessage({ ok: true, base64: base64 });
    });
  }).catch(function(err) {
    self.postMessage({ ok: false, error: err.message });
  });
};
