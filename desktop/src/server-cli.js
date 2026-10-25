const { HomeCloudServer } = require('./sync-server');

async function run() {
  const server = new HomeCloudServer({ port: 4820, udpPort: 4821 });
  const info = await server.start();
  console.log('====================================================');
  console.log(' HomeCloud Sync Server Running');
  console.log(` Server URL:     ${info.serverUrl}`);
  console.log(` Mobile Web URL: ${info.mobileWebUrl}`);
  console.log(` Pair Code:      ${info.pairCode}`);
  console.log(` Storage Dir:    ${info.storageDir}`);
  console.log('====================================================');
}

run().catch((err) => {
  console.error('Failed to start HomeCloud server:', err);
  process.exit(1);
});
