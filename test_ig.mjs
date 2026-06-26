// Test the deployed worker's /api/preview with a real Instagram Reel URL
const workerUrl = 'https://tiktok-fetcher.p2scalworkhost.workers.dev';
const testUrl = 'https://www.instagram.com/reel/DZAhWPixshc/';

async function testWorker() {
  console.log('Testing Cloudflare Worker API...');
  console.log('Worker URL:', workerUrl);
  console.log('Target URL:', testUrl);

  try {
    const res = await fetch(`${workerUrl}/api/preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        tiktokUrl: testUrl
      })
    });

    const data = await res.json();
    console.log('\nResponse Status:', res.status);
    console.log('Response Body:', JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error during test:', err);
  }
}

testWorker();
