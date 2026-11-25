import { createConnection, createServer, type AddressInfo, type Server, type Socket } from "node:net";

// GreenMail accepts an empty HEADER.FIELDS list, which RFC 3501 forbids.
// This proxy forwards to GreenMail but answers that command the way Migadu
// does. It inspects each client write as a whole, which holds for ImapFlow's
// one-write-per-command FETCH; a command split across writes would slip past.
const EMPTY_HEADER_FIELDS = /HEADER\.FIELDS \(\)/;

export interface StrictImapProxy {
  port: number;
  openConnections(): number;
  close(): Promise<void>;
}

export async function startStrictImapProxy(upstreamPort: number): Promise<StrictImapProxy> {
  const clients = new Set<Socket>();
  const server: Server = createServer((client) => {
    clients.add(client);
    client.on("close", () => clients.delete(client));
    const upstream = createConnection({ host: "localhost", port: upstreamPort });
    upstream.on("data", (chunk) => client.write(chunk));
    upstream.on("close", () => client.destroy());
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    client.on("error", () => upstream.destroy());
    client.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      if (EMPTY_HEADER_FIELDS.test(text)) {
        const tag = text.split(" ", 1)[0];
        client.write(`${tag} BAD [CLIENTBUG] Syntax error: expected list element, got ")"\r\n`);
        return;
      }
      upstream.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    openConnections: () => clients.size,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      for (const client of clients) client.destroy();
    }),
  };
}
