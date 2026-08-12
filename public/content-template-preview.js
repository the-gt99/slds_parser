export function previewFrameDocument(html) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><style>body{margin:0;padding:18px;font:14px/1.55 system-ui,sans-serif;color:#20242d}h2,h3{line-height:1.25;margin:0 0 12px}p{margin:0 0 12px}ul,ol{padding-left:22px}li{margin:5px 0}a{color:#176b52}</style></head><body>${html || '<span style="color:#78818e">Поле пустое</span>'}</body></html>`;
}

export function replacePreviewFrame(documentNode, currentFrame, html) {
  const nextFrame = documentNode.createElement("iframe");
  nextFrame.id = currentFrame.id;
  nextFrame.title = currentFrame.title;
  nextFrame.setAttribute("sandbox", "");
  nextFrame.srcdoc = previewFrameDocument(html);
  currentFrame.replaceWith(nextFrame);
  return nextFrame;
}
