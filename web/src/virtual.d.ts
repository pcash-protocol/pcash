declare module "*.css?inline" {
  const css: string;
  export default css;
}

interface Window {
  ethereum?: import("viem").EIP1193Provider;
}
