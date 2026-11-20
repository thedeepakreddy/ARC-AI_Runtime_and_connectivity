import { useAuthConfig } from '@arc/ui/auth';
import { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    adsbygoogle?: unknown[];
  }
}

const SCRIPT_ID = 'adsbygoogle-js';
const wide = () => window.matchMedia('(min-width: 901px)').matches;

/**
 * A Google AdSense unit in the sidebar, between the navigation and the account panel. Nothing
 * loads unless this ARC has AdSense configured (ADSENSE_CLIENT/ADSENSE_SLOT), and not on phones
 * (the sidebar is a drawer there). The page's CSP allows Google's loader by nonce only.
 */
export function AdSlot() {
  const config = useAuthConfig();
  const ads = config?.ads;
  const [show] = useState(wide);
  const pushed = useRef(false);

  useEffect(() => {
    if (!ads || !show || pushed.current) return;
    if (!document.getElementById(SCRIPT_ID)) {
      const s = document.createElement('script');
      s.id = SCRIPT_ID;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(ads.client)}`;
      document.head.appendChild(s);
    }
    pushed.current = true;
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  }, [ads, show]);

  if (!ads || !show) return null;
  return (
    <div className="ad-slot">
      <span className="ad-label">Advertisement</span>
      <ins
        className="adsbygoogle"
        style={{ display: 'inline-block', width: 200, height: 300 }}
        data-ad-client={ads.client}
        data-ad-slot={ads.slot}
      />
    </div>
  );
}
