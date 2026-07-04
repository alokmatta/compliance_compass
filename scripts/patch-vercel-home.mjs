import { readFile, writeFile } from "node:fs/promises";

const configPath = new URL("../.vercel/output/config.json", import.meta.url);
const serverPath = new URL("../.vercel/output/functions/__server.func/index.mjs", import.meta.url);

try {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const rootRoute = config.routes?.find((route) => route?.src === "/");
  if (rootRoute) {
    rootRoute.dest = "/home";
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log("[build] routed / to /home in Vercel output");
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

try {
  const source = await readFile(serverPath, "utf8");
  const patched = source.replace(
    "handler: toEventHandler(_eve_route_default)",
    "handler: toEventHandler(home_default)",
  );

  if (patched !== source) {
    await writeFile(serverPath, patched);
    console.log("[build] routed server / handler to /home");
  }
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
