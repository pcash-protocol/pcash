import { useMemo } from "react";
import encodeQR from "qr";
import styles from "./QrCode.module.css";

const QUIET_ZONE = 4;

/** `value`, a short link or address, as a scannable QR code. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const modules = encodeQR(value, "raw", { ecc: "medium" });
    let path = "";
    modules.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) path += `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`;
    }));
    return { size: modules.length + QUIET_ZONE * 2, path };
  }, [value]);
  return <svg className={styles.qr} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
    <rect width={size} height={size} fill="#fff" />
    <path d={path} fill="#000" />
  </svg>;
}
