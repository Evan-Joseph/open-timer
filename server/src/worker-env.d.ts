/** worker.ts 专用类型声明（esbuild 以 text loader 内嵌 .sql；Fetcher 为 assets binding 的最小形状）。 */

declare module '*.sql' {
  const content: string;
  export default content;
}

type Fetcher = {
  fetch(input: Request | string): Promise<Response>;
};
