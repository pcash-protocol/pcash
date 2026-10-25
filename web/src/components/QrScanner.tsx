import { useEffect, useRef, useState } from "react";
import styles from "./QrScanner.module.css";

type ScanState = { state: "starting" } | { state: "scanning" } | { state: "failed"; message: string };

function cameraFailure(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera access was blocked. Allow camera access for this site in your browser settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this device.";
  if (name === "NotReadableError") return "The camera is in use by another app.";
  return "The camera could not start.";
}

/**
 * Reads one QR code from the device camera, preferring the rear camera and
 * falling back to whichever camera exists. The camera stops on unmount.
 */
export function QrScanner({ onScan, onClose }: { onScan(text: string): void; onClose(): void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [scan, setScan] = useState<ScanState>({ state: "starting" });
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const camera = useRef<import("qr/dom.js").QRCamera | undefined>(undefined);
  const scanned = useRef(onScan);
  scanned.current = onScan;
  useEffect(() => {
    let stopped = false;
    let cancelLoop: (() => void) | undefined;
    if (typeof navigator.mediaDevices?.getUserMedia !== "function") {
      setScan({ state: "failed", message: window.isSecureContext ? "This browser cannot use the camera." : "The camera needs a secure (https) connection." });
      return;
    }
    void (async () => {
      const { QRCanvas, frameLoop, rearCamera } = await import("qr/dom.js");
      const player = video.current;
      if (stopped || player === null) return;
      const opened = await rearCamera(player);
      if (stopped) { opened.stop(); return; }
      camera.current = opened;
      setScan({ state: "scanning" });
      void opened.listDevices().then((list) => { if (!stopped) setDevices(list); }, () => undefined);
      const canvas = new QRCanvas({}, { cropToSquare: false });
      let reading = false;
      cancelLoop = frameLoop(() => {
        if (reading) return;
        reading = true;
        void opened.readFrame(canvas).then((result) => {
          const text = Array.isArray(result) ? undefined : result;
          if (stopped || text === undefined || text === "") return;
          stopped = true;
          cancelLoop?.();
          opened.stop();
          scanned.current(text);
        }, () => undefined).finally(() => { reading = false; });
      }, player);
    })().catch((cause) => { if (!stopped) setScan({ state: "failed", message: cameraFailure(cause) }); });
    return () => {
      stopped = true;
      cancelLoop?.();
      camera.current?.stop();
      camera.current = undefined;
    };
  }, []);
  return <div className={styles.scanner} role="region" aria-label="Scan a QR code">
    <div className={styles.viewport}>
      <video ref={video} className={styles.video} muted playsInline aria-hidden="true" />
      {scan.state === "scanning" && <span className={styles.frame} aria-hidden="true" />}
      {scan.state === "starting" && <p className={styles.overlayText} role="status">Starting camera…</p>}
    </div>
    {scan.state === "failed" ? <p className={styles.error} role="alert">{scan.message}</p>
      : <p className={styles.hint} role="status">{scan.state === "scanning" ? "Point the camera at a profile link or address QR code." : "Allow camera access if your browser asks."}</p>}
    <div className={styles.actions}>
      {devices.length > 1 && <select aria-label="Camera" onChange={(event) => void camera.current?.setDevice(event.target.value)}>
        {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}
      </select>}
      <button type="button" className="button" onClick={onClose}>Cancel</button>
    </div>
  </div>;
}
