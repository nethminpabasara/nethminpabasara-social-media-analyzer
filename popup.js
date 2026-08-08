// REPLACE THIS WITH YOUR LIVE VERCEL DOMAIN (keep /api/analyze at the end)
const VERCEL_API_URL = 'https://social-analyzer-extension.vercel.app/api/analyze';

document.getElementById('scrapeBtn').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.innerText = 'Extracting profile data...';

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (err) {
    status.innerText = 'Could not access the current tab.';
    return;
  }

  if (!tab || !tab.url || !tab.url.includes('instagram.com')) {
    status.innerText = 'Open an Instagram profile page first!';
    return;
  }

  chrome.scripting.executeScript(
    {
      target: { tabId: tab.id },
      func: scrapeInstagramDOM
    },
    async (results) => {
      if (chrome.runtime.lastError) {
        status.innerText = 'Scrape failed: ' + chrome.runtime.lastError.message;
        return;
      }

      const profileData = results?.[0]?.result;
      if (!profileData || !profileData.handle) {
        status.innerText = 'Open an Instagram profile page first!';
        return;
      }

      status.innerText = 'Analyzing with AI...';

      try {
        const response = await fetch(VERCEL_API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(profileData)
        });

        let resData;
        try {
          resData = await response.json();
        } catch {
          status.innerText = 'Server returned an unexpected response.';
          return;
        }

        if (response.ok && resData.success) {
          status.innerText = `Analysis saved for @${profileData.handle}!`;
        } else {
          status.innerText = 'API Error: ' + (resData.error || `HTTP ${response.status}`);
        }
      } catch (err) {
        status.innerText = 'Connection failed. Check Vercel URL and your internet connection.';
      }
    }
  );
});

// Runs inside the Instagram page itself (injected via chrome.scripting).
// Only pulls data already visible in the DOM to the logged-in viewer --
// this cannot access private analytics, reach, or impressions.
function scrapeInstagramDOM() {
  const handle = window.location.pathname.replace(/\//g, '');

  const bioElement = document.querySelector('header section div span') || document.querySelector('header h1');
  const bio = bioElement ? bioElement.innerText : 'No bio found';

  // Follower count, when visible on the page header
  let followerCount = null;
  const statLinks = document.querySelectorAll('header section ul li');
  statLinks.forEach((li) => {
    const text = li.innerText || '';
    if (/follower/i.test(text)) {
      followerCount = text;
    }
  });

  const posts = document.querySelectorAll('main article a');
  const recentCaptions = [];

  posts.forEach((postLink) => {
    if (recentCaptions.length >= 6) return;
    const img = postLink.querySelector('img');
    const alt = img?.alt || '';
    // Instagram often prefixes alt text with something like
    // "Photo by X on <date>. May be an image of ...", which also
    // carries a rough date signal we keep as-is for the AI to use loosely.
    if (alt.length > 5) {
      recentCaptions.push(alt);
    }
  });

  return { handle, bio, followerCount, recentCaptions };
}