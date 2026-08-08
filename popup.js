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

  const platform = detectPlatform(tab?.url);
  if (!platform) {
    status.innerText = 'Open an Instagram, Facebook, or TikTok profile page first!';
    return;
  }

  const scraperFunction = SCRAPERS[platform];

  chrome.scripting.executeScript(
    {
      target: { tabId: tab.id },
      func: scraperFunction
    },
    async (results) => {
      if (chrome.runtime.lastError) {
        status.innerText = 'Scrape failed: ' + chrome.runtime.lastError.message;
        return;
      }

      const profileData = results?.[0]?.result;
      if (!profileData || !profileData.handle) {
        status.innerText = `Could not read this ${platform} profile. Make sure the page has fully loaded.`;
        return;
      }

      profileData.platform = platform;
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

// Figures out which platform the current tab is on
function detectPlatform(url) {
  if (!url) return null;
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('facebook.com')) return 'facebook';
  if (url.includes('tiktok.com')) return 'tiktok';
  return null;
}

// --- Scraper functions ---
// Each one runs INSIDE the actual page (injected by chrome.scripting).
// Only reads what's already visible in the DOM to the logged-in viewer --
// none of these can access private analytics, reach, or impressions.

function scrapeInstagramDOM() {
  const handle = window.location.pathname.replace(/\//g, '');

  const bioElement = document.querySelector('header section div span') || document.querySelector('header h1');
  const bio = bioElement ? bioElement.innerText : 'No bio found';

  let followerCount = null;
  const statLinks = document.querySelectorAll('header section ul li');
  statLinks.forEach((li) => {
    const text = li.innerText || '';
    if (/follower/i.test(text)) followerCount = text;
  });

  const posts = document.querySelectorAll('main article a');
  const recentCaptions = [];
  posts.forEach((postLink) => {
    if (recentCaptions.length >= 6) return;
    const img = postLink.querySelector('img');
    const alt = img?.alt || '';
    if (alt.length > 5) recentCaptions.push(alt);
  });

  return { handle, bio, followerCount, recentCaptions };
}

function scrapeFacebookDOM() {
  // Facebook Page URLs look like facebook.com/PageName or facebook.com/profile.php?id=...
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const handle = pathParts[0] || 'facebook_page';

  const bioElement = document.querySelector('[data-testid="page_intro_card"]') ||
                      document.querySelector('div[data-pagelet="ProfileTilesFeed"]');
  const bio = bioElement ? bioElement.innerText.slice(0, 500) : 'No bio found';

  let followerCount = null;
  const bodyText = document.body.innerText;
  const followerMatch = bodyText.match(/[\d,.]+[KMB]?\s+followers/i);
  if (followerMatch) followerCount = followerMatch[0];

  // Facebook post text is inconsistent to target reliably by class name,
  // so we grab visible text blocks that look like post content as a best-effort.
  const postNodes = document.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"]');
  const recentCaptions = Array.from(postNodes)
    .map(n => n.innerText)
    .filter(t => t && t.length > 5)
    .slice(0, 6);

  return { handle, bio, followerCount, recentCaptions };
}

function scrapeTikTokDOM() {
  const handle = window.location.pathname.replace(/\//g, '').replace('@', '');

  const bioElement = document.querySelector('[data-e2e="user-bio"]');
  const bio = bioElement ? bioElement.innerText : 'No bio found';

  let followerCount = null;
  const followerElement = document.querySelector('[data-e2e="followers-count"]');
  if (followerElement) followerCount = followerElement.innerText;

  const videoDescNodes = document.querySelectorAll('[data-e2e="user-post-item-desc"]');
  const recentCaptions = Array.from(videoDescNodes)
    .map(n => n.innerText)
    .filter(t => t && t.length > 5)
    .slice(0, 6);

  return { handle, bio, followerCount, recentCaptions };
}

const SCRAPERS = {
  instagram: scrapeInstagramDOM,
  facebook: scrapeFacebookDOM,
  tiktok: scrapeTikTokDOM
};