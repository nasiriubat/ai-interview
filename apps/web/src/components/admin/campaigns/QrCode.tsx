import qrcode from "qrcode-generator";
import * as React from "react";

/** Quiet zone, in modules, that the QR specification asks for around the code. */
const QUIET = 4;

/**
 * The modules of a QR code as one SVG path, so the markup is a single element and the colours are
 * set by the caller. Error correction level M: a link that is a few dozen characters fits version
 * 3 or 4, and M survives a creased poster.
 *
 * Generated here, in the page, with a small vetted library (qrcode-generator, MIT, no dependencies):
 * the share link is a secret that opens interviews, so it is never sent to a QR service.
 */
export function qrPath(value: string): { path: string; size: number } {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++;
        continue;
      }
      let run = 1;
      while (c + run < n && qr.isDark(r, c + run)) run++;
      d += `M${String(c + QUIET)} ${String(r + QUIET)}h${String(run)}v1h-${String(run)}z`;
      c += run;
    }
  }
  return { path: d, size: n + QUIET * 2 };
}

/**
 * A QR code as an image with a text alternative. It is always dark on light, whatever the theme,
 * because a scanner needs that contrast; the surrounding card carries the dark theme.
 */
export function QrCode({
  value,
  label,
  className,
}: {
  value: string;
  label: string;
  className?: string | undefined;
}): React.JSX.Element {
  const { path, size } = qrPath(value);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
      className={className}
    >
      <rect width={size} height={size} fill="white" />
      <path d={path} fill="black" />
    </svg>
  );
}

/** The same code as a stand-alone SVG document, for a download. */
export function qrSvgDocument(value: string): string {
  const { path, size } = qrPath(value);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${String(size)} ${String(size)}" width="${String(size * 8)}" height="${String(size * 8)}" shape-rendering="crispEdges"><rect width="${String(size)}" height="${String(size)}" fill="white"/><path d="${path}" fill="black"/></svg>`;
}
