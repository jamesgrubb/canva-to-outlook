declare module "*.css" {
  const styles: { [className: string]: string };
  export = styles;
}

declare const BACKEND_HOST: string;
