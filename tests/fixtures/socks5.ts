import net from 'node:net';

/** Minimal SOCKS5 server (RFC 1928/1929, username/password) that leaves via `exitAddress`. */
export async function startSocks5(opts: { password: string; exitAddress?: string }): Promise<{ port: number; auths: string[]; close(): void }> {
  const auths: string[] = [];
  const server = net.createServer((c) => {
    c.once('data', (greet) => {
      if (greet[0] !== 5) return c.destroy();
      c.write(Buffer.from([5, 2]));
      c.once('data', (auth) => {
        const ulen = auth[1];
        const user = auth.subarray(2, 2 + ulen).toString();
        const plen = auth[2 + ulen];
        const pass = auth.subarray(3 + ulen, 3 + ulen + plen).toString();
        auths.push(`${user}:${pass}`);
        if (pass !== opts.password) return void c.end(Buffer.from([1, 1]));
        c.write(Buffer.from([1, 0]));
        c.once('data', (req) => {
          let host: string;
          let off: number;
          if (req[3] === 1) {
            host = [...req.subarray(4, 8)].join('.');
            off = 8;
          } else {
            const len = req[4];
            host = req.subarray(5, 5 + len).toString();
            off = 5 + len;
          }
          const port = req.readUInt16BE(off);
          const out = net.connect({ host, port, localAddress: opts.exitAddress }, () => {
            c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
            c.pipe(out).pipe(c);
          });
          out.on('error', () => c.destroy());
        });
      });
    });
    c.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as net.AddressInfo).port, auths, close: () => server.close() };
}
