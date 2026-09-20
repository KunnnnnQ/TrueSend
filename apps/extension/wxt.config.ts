import {defineConfig} from "wxt";

export default defineConfig({
  srcDir: ".",
  manifest: {
    name: "TrueSend",
    description:
      "Shows a fingerprint for every address you copy, and spots addresses on a page that a wallet would render identically.",
    // Nothing is sent anywhere. Clipboard reads happen through the page's own copy event rather
    // than the clipboard API, so the extension never needs permission to read the clipboard at
    // rest — only to see what the user just copied on a page they are already looking at.
    permissions: ["storage"],
    host_permissions: ["<all_urls>"],
  },
});
