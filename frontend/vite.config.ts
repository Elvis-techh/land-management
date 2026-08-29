import { hostname } from "node:os";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The hostname this dev server is being reached through, when that is not the
 * machine's own LAN address.
 *
 * Set it when serving Lindero through a tunnel or a Tailscale name, e.g.
 *
 *   VITE_PUBLIC_HOST=lindero.example.trycloudflare.com npm run dev:frontend
 *
 * Without it, hot reload tries to open a websocket back to the tunnel's
 * hostname on port 5173, which nothing is listening on — so the page loads and
 * then silently stops updating.
 */
const publicHost = process.env.VITE_PUBLIC_HOST;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // `host: true` exposes the dev server on your local network so you can open
    // Lindero on your real phone (http://<your-computer-ip>:5173) instead of
    // only trusting Chrome's device toolbar.
    host: true,
    /*
     * Vite refuses any request whose Host header it does not recognise. That
     * check exists to stop a malicious page from re-pointing a hostname at your
     * dev server, and it is worth keeping — but it also means a tunnel or a
     * Tailscale hostname is answered with "Blocked request" rather than the
     * app, which looks exactly like a network fault.
     *
     * A leading dot matches subdomains, so these cover the tunnels without
     * opening the server to every hostname on the internet.
     */
    allowedHosts: [
      ".trycloudflare.com",
      ".ngrok-free.app",
      ".ngrok.io",
      // Tailscale's full MagicDNS name, e.g. laptop.tailXXXX.ts.net
      ".ts.net",
      // Bonjour/mDNS, e.g. http://elvis-msi.local:5173
      ".local",
      /*
       * This machine's own hostname, bare.
       *
       * Tailscale's MagicDNS puts the tailnet in the phone's DNS search path,
       * so typing just the short name resolves — and the browser then sends
       * `Host: elvis-msi-fishbone`, which matches neither ".ts.net" nor
       * ".local" and came back as "Blocked request". Same phone, same wifi,
       * working or not depending only on whether the short or the long name was
       * typed: precisely the kind of thing that reads as a flaky network.
       */
      hostname(),
      hostname().toLowerCase(),
    ],
    // Over a tunnel the page arrives on HTTPS/443, so the reload socket has to
    // as well. On the LAN the defaults are correct and this stays out of the way.
    hmr: publicHost ? { host: publicHost, protocol: "wss", clientPort: 443 } : undefined,
    // Anything the app requests at /api/... is forwarded to the Fastify backend
    // on port 3000. This means frontend code always calls "/api/lots" and never
    // needs to know the backend's address, in dev or in production — and it is
    // why a tunnel only ever has to expose ONE port, not two.
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
