/**
 * Browser-side DNG/TIFF decoder for CFA/Bayer float32 images (e.g. Spheron cameras).
 * Decodes to an HTML Canvas with progressive row-by-row rendering.
 *
 * Usage: decodeDngToCanvas(arrayBuffer, canvas, onProgress, onDone)
 *   onProgress(fraction) — called as rows are decoded (0..1)
 *   onDone(errorOrNull)  — called when complete or on error
 */
(function() {
  'use strict';

  var T_W = 256, T_H = 257, T_BPS = 258, T_COMP = 259, T_PHOTO = 262;
  var T_SOFF = 273, T_SPP = 277, T_RPS = 278, T_SBC = 279;
  var T_SF = 339, T_SUB = 330, T_CFA_DIM = 33421, T_CFA_PAT = 33422;
  var TSIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

  window.decodeDngToCanvas = function(ab, canvas, onProgress, onDone) {
    try {
      var dv = new DataView(ab), len = ab.byteLength;
      if (len < 8) return onDone('File too small');

      var le = (dv.getUint8(0) === 0x49 && dv.getUint8(1) === 0x49);
      if (!le && !(dv.getUint8(0) === 0x4D && dv.getUint8(1) === 0x4D))
        return onDone('Not a TIFF file');

      function u16(o) { return dv.getUint16(o, le); }
      function u32(o) { return dv.getUint32(o, le); }

      if (u16(2) !== 42) return onDone('Bad TIFF magic');

      function parseIfd(off) {
        if (off + 2 > len) return { e: [], next: 0 };
        var n = u16(off), entries = [];
        for (var i = 0; i < n; i++) {
          var p = off + 2 + i * 12;
          if (p + 12 > len) break;
          entries.push({ tag: u16(p), type: u16(p + 2), cnt: u32(p + 4), vo: p + 8 });
        }
        var nOff = off + 2 + n * 12;
        return { e: entries, next: (nOff + 4 <= len) ? u32(nOff) : 0 };
      }

      function gv(e) {
        var s = TSIZE[e.type] || 1, o = (e.cnt * s > 4) ? u32(e.vo) : e.vo;
        return (e.type === 3) ? u16(o) : u32(o);
      }

      function gvs(e) {
        var s = TSIZE[e.type] || 1, o = (e.cnt * s > 4) ? u32(e.vo) : e.vo;
        var r = [];
        for (var i = 0; i < e.cnt; i++) {
          if (e.type === 3) r.push(u16(o + i * 2));
          else if (e.type === 1 || e.type === 7) r.push(dv.getUint8(o + i));
          else r.push(u32(o + i * 4));
        }
        return r;
      }

      function ft(entries, tag) {
        for (var i = 0; i < entries.length; i++)
          if (entries[i].tag === tag) return entries[i];
        return null;
      }

      // Collect all IFDs
      var ifd0Off = u32(4);
      var ifd0 = parseIfd(ifd0Off);
      var allIfds = [ifd0.e];
      var seen = {};
      seen[ifd0Off] = 1;
      var nxt = ifd0.next;
      while (nxt > 0 && nxt < len && !seen[nxt]) {
        seen[nxt] = 1;
        allIfds.push(parseIfd(nxt).e);
        nxt = parseIfd(nxt).next;
      }
      var subE = ft(ifd0.e, T_SUB);
      if (subE) {
        var subOffs = gvs(subE);
        for (var i = 0; i < subOffs.length; i++) {
          if (subOffs[i] > 0 && subOffs[i] < len && !seen[subOffs[i]]) {
            seen[subOffs[i]] = 1;
            allIfds.push(parseIfd(subOffs[i]).e);
          }
        }
      }

      // Find best IFD (largest with strip data)
      var best = null;
      for (var i = 0; i < allIfds.length; i++) {
        var wE = ft(allIfds[i], T_W), hE = ft(allIfds[i], T_H);
        if (!wE || !hE) continue;
        var w = gv(wE), h = gv(hE);
        if (!ft(allIfds[i], T_SOFF)) continue;
        if (!best || w * h > best.w * best.h) {
          var phE = ft(allIfds[i], T_PHOTO);
          best = { e: allIfds[i], w: w, h: h, isCfa: !!(phE && gv(phE) === 32803) };
        }
      }
      if (!best) return onDone('No usable image IFD found');

      var E = best.e, W = best.w, H = best.h;
      var bpsE = ft(E, T_BPS), bps = bpsE ? gv(bpsE) : 8;
      var sfE = ft(E, T_SF), sf = sfE ? gv(sfE) : 1;
      var sppE = ft(E, T_SPP), spp = sppE ? gv(sppE) : 1;
      var compE = ft(E, T_COMP), comp = compE ? gv(compE) : 1;
      var rpsE = ft(E, T_RPS), rps = rpsE ? gv(rpsE) : H;
      var soE = ft(E, T_SOFF), sbcE = ft(E, T_SBC);
      var sOffs = soE ? gvs(soE) : [];
      var sBcs = sbcE ? gvs(sbcE) : [];

      if (comp !== 1) return onDone('Compressed DNG not supported in browser (compression=' + comp + ')');

      var bytesPerSample = bps / 8;

      // CFA pattern (default RGGB)
      var cfaPat = [0, 1, 1, 2];
      var cfaDimE = ft(E, T_CFA_DIM), cfaPatE = ft(E, T_CFA_PAT);
      if (cfaPatE && cfaDimE) {
        var cpv = gvs(cfaPatE);
        if (cpv.length >= 4) cfaPat = cpv.slice(0, 4);
      }
      var c00 = cfaPat[0], c01 = cfaPat[1], c10 = cfaPat[2], c11 = cfaPat[3];

      // Read one sample at (row, col) from strip data
      function rs(row, col) {
        var si = (row / rps) | 0;
        if (si >= sOffs.length) return 0;
        var off = sOffs[si] + ((row - si * rps) * W + col) * spp * bytesPerSample;
        if (sf === 3 && bps === 32) {
          return (off + 4 <= len) ? dv.getFloat32(off, le) : 0;
        } else if (bps === 16) {
          return (off + 2 <= len) ? dv.getUint16(off, le) : 0;
        }
        return (off < len) ? dv.getUint8(off) : 0;
      }

      // Auto-exposure: find max value by scanning raw strip data directly
      var maxV = 0;
      for (var si = 0; si < sOffs.length; si++) {
        var sOff = sOffs[si], sLen = sBcs[si] || 0;
        if (sf === 3 && bps === 32) {
          for (var j = 0; j + 4 <= sLen; j += 16) { // sample every 4th value for speed
            var v = dv.getFloat32(sOff + j, le);
            if (v > maxV) maxV = v;
          }
        } else if (bps === 16) {
          for (var j = 0; j + 2 <= sLen; j += 8) {
            var v = dv.getUint16(sOff + j, le);
            if (v > maxV) maxV = v;
          }
        }
      }
      if (maxV <= 0) maxV = 1;
      var scale = 1.0 / maxV;
      var gamma = 1.0 / 2.2;

      // Determine output dimensions and decode mode
      var outW, outH, isCfa = best.isCfa && spp === 1;

      if (isCfa) {
        // Half-size CFA demosaic: 2x2 Bayer block -> 1 pixel
        outW = (W / 2) | 0;
        outH = (H / 2) | 0;
      } else {
        // Non-CFA: direct output at full resolution
        outW = W;
        outH = H;
      }

      canvas.width = outW;
      canvas.height = outH;
      var ctx = canvas.getContext('2d');
      var BATCH = 75;
      var curY = 0;

      function decodeBatch() {
        var endY = Math.min(curY + BATCH, outH);
        var imgData = ctx.createImageData(outW, endY - curY);
        var d = imgData.data;

        if (isCfa) {
          // CFA half-size demosaic
          for (var by = curY; by < endY; by++) {
            var y0 = by * 2;
            for (var bx = 0; bx < outW; bx++) {
              var x0 = bx * 2;
              var v00 = rs(y0, x0), v01 = rs(y0, x0 + 1);
              var v10 = rs(y0 + 1, x0), v11 = rs(y0 + 1, x0 + 1);

              var ch = [0, 0, 0], cnt = [0, 0, 0];
              if (isFinite(v00)) { ch[c00] += v00; cnt[c00]++; }
              if (isFinite(v01)) { ch[c01] += v01; cnt[c01]++; }
              if (isFinite(v10)) { ch[c10] += v10; cnt[c10]++; }
              if (isFinite(v11)) { ch[c11] += v11; cnt[c11]++; }

              var pix = ((by - curY) * outW + bx) * 4;
              for (var c = 0; c < 3; c++) {
                var val = cnt[c] > 0 ? ch[c] / cnt[c] : 0;
                if (val < 0) val = 0;
                d[pix + c] = Math.min(255, (Math.pow(val * scale, gamma) * 255 + 0.5) | 0);
              }
              d[pix + 3] = 255;
            }
          }
        } else {
          // Non-CFA: read RGB directly
          var outCh = Math.min(spp, 3);
          for (var y = curY; y < endY; y++) {
            for (var x = 0; x < outW; x++) {
              var pix = ((y - curY) * outW + x) * 4;
              for (var c = 0; c < 3; c++) {
                var srcC = c < outCh ? c : 0;
                var si = (y / rps) | 0;
                var off = sOffs[si] + ((y - si * rps) * W + x) * spp * bytesPerSample + srcC * bytesPerSample;
                var val = 0;
                if (sf === 3 && bps === 32) {
                  val = (off + 4 <= len) ? dv.getFloat32(off, le) : 0;
                } else if (bps === 16) {
                  val = (off + 2 <= len) ? dv.getUint16(off, le) : 0;
                  val = val / 257; // 16-bit to 0-255 range
                } else {
                  val = (off < len) ? dv.getUint8(off) : 0;
                }
                if (sf === 3) {
                  if (!isFinite(val) || val < 0) val = 0;
                  d[pix + c] = Math.min(255, (Math.pow(val * scale, gamma) * 255 + 0.5) | 0);
                } else if (bps === 16) {
                  d[pix + c] = Math.min(255, Math.max(0, Math.round(val)));
                } else {
                  d[pix + c] = val;
                }
              }
              d[pix + 3] = 255;
            }
          }
        }

        ctx.putImageData(imgData, 0, curY);
        curY = endY;
        onProgress(curY / outH);

        if (curY < outH) {
          requestAnimationFrame(decodeBatch);
        } else {
          onDone(null);
        }
      }

      requestAnimationFrame(decodeBatch);
    } catch (e) {
      onDone(e.message || String(e));
    }
  };
})();
