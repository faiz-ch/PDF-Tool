/* Ghostscript compression worker (classic worker, runs entirely in the browser).
 * Receives { id, pdf: ArrayBuffer, dpi } and returns { id, ok, pdf?: ArrayBuffer, error? }.
 * A fresh Ghostscript instance is created per job (the engine is not safe to re-run),
 * but the compiled WebAssembly module is cached so only the first job pays the load cost. */
importScripts('gs.js');

let compiled = null;
function getCompiled() {
  if (!compiled) {
    compiled = fetch('gs.wasm')
      .then((r) => {
        if (!r.ok) throw new Error('Could not load compression engine (gs.wasm)');
        return r.arrayBuffer();
      })
      .then((buf) => WebAssembly.compile(buf));
  }
  return compiled;
}

async function compress(pdf, dpi) {
  const wasmModule = await getCompiled();
  const logs = [];
  const gs = await Module({
    noInitialRun: true,
    print: () => {},
    printErr: (t) => logs.push(t),
    instantiateWasm: (imports, done) => {
      WebAssembly.instantiate(wasmModule, imports).then((inst) => done(inst));
      return {};
    },
  });
  gs.FS.writeFile('/in.pdf', new Uint8Array(pdf));
  const code = gs.callMain([
    '-sDEVICE=pdfwrite',
    '-dCompatibilityLevel=1.5',
    '-dPDFSETTINGS=/ebook',
    '-dNOPAUSE',
    '-dBATCH',
    '-dQUIET',
    '-dDetectDuplicateImages=true',
    '-dCompressFonts=true',
    '-dSubsetFonts=true',
    '-dDownsampleColorImages=true',
    '-dDownsampleGrayImages=true',
    '-dDownsampleMonoImages=true',
    '-dColorImageDownsampleType=/Bicubic',
    '-dGrayImageDownsampleType=/Bicubic',
    '-dColorImageResolution=' + dpi,
    '-dGrayImageResolution=' + dpi,
    '-dMonoImageResolution=' + dpi * 2,
    '-sOutputFile=/out.pdf',
    '/in.pdf',
  ]);
  if (code !== 0) throw new Error('Compression failed (' + code + '): ' + logs.slice(-3).join(' '));
  return gs.FS.readFile('/out.pdf');
}

self.onmessage = async (e) => {
  const { id, pdf, dpi } = e.data;
  try {
    const out = await compress(pdf, dpi);
    const buf = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    self.postMessage({ id, ok: true, pdf: buf }, [buf]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};
