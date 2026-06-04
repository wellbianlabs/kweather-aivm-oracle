// Vercel CLI puts os.hostname() into an HTTP header; a non-ASCII (Korean) machine
// name is an illegal header value. Force an ASCII hostname for the CLI process.
const os = require("os");
os.hostname = () => "kweather-deploy";
