(async () => {
  const mod = await import('../public/js/mount/render.js');
  const b = { id: 'f', kind: 'text', parent: null, x: 5, y: 5, w: 50, h: 10, z: 0, visible: true, text: 'A&B<tag>"q"', detail: 'D&E<d>"' };
  const html = mod.boxesToHtml([b]);
  const m = /data-detail="([^"]*)"/.exec(html);
  console.log('dm match:', m && JSON.stringify(m[1]));
  const m2 = /data-box-id="f"[^>]*/.exec(html);
  console.log('box attr src:', JSON.stringify(m2 && m2[0]));
  const r = mod.collectBoxes(html);
  console.log('detail in round:', r[0].detail);
})().catch((e) => { console.error(e); process.exit(1); });