export function startStaticHost(options: {
  root: string;
  host?: string;
  port?: number;
}): Promise<{
  url: string;
  close(): Promise<void>;
}>;
