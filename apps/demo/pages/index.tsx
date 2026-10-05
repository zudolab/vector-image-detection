import { Island } from "@takazudo/zfb";
import { App } from "../src/App";

export default function DemoPage() {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content="A public AI photo library for uploading, human tagging, and tiered search."
        />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <title>Public AI photo library</title>
      </head>
      <body>
        <Island
          ssrFallback={
            <main class="grid min-h-screen place-items-center px-md py-lg">
              <p class="text-muted">Loading the photo library&hellip;</p>
            </main>
          }
        >
          <App />
        </Island>
      </body>
    </html>
  );
}
