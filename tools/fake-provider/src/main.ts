#!/usr/bin/env node
import { startFakeProvider } from "./server.js";

const port = Number(process.env.PORT ?? 4010);
const host = process.env.HOST ?? "0.0.0.0";
const provider = await startFakeProvider({ port, host });
// One line, so a compose log says what is listening and with which behaviour.
// eslint-disable-next-line no-console -- the one startup line a container log needs
console.log(
  JSON.stringify({
    msg: "fake-provider listening",
    url: `http://${host}:${port}/v1`,
    behaviour: provider.behaviour(),
  }),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void provider.close().then(() => process.exit(0));
  });
}
