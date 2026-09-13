(async () => {
  const mod = await import('../public/js/mount/render.js');
  const b = { id: 'f', kind: 'text', parent: null, x: 5, y: 5, w: 50, h: 10, z: 0, visible: true, text: 'A&B<tag>"q"', detail: 'D&E<d>"' };
  const html = mod.boxesToHtml([b]);
  console.log('HTML:', html);
  const r = mod.collectBoxes(html);
  console.log('round:', JSON.stringify(r[0]));
})().catch((e) => { console.error(e); process.exit(1); });
