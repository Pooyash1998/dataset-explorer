// Copies the static site into dist/ after Tailwind has written css/app.css (used by the Vercel build).
import { cpSync, rmSync, mkdirSync } from "node:fs";
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/css", { recursive: true });
cpSync("index.html", "dist/index.html");
cpSync("js", "dist/js", { recursive: true });
cpSync("css/app.css", "dist/css/app.css");
