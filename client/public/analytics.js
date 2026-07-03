(function() {
  var ENDPOINT = '/api/public/analytics/event';
  var BATCH_ENDPOINT = '/api/public/analytics/batch';

  // Server-set attribution cookies (see server/attribution-cookies.ts).
  // usg_vid = visitor id (2y), usg_cid = click id (90d). Read-only from JS.
  var VID_COOKIE = 'usg_vid';
  var CID_COOKIE = 'usg_cid';
  // Legacy visitor id (pre-attribution). Kept as a fallback + stitching signal.
  var LEGACY_VID_KEY = '_cufc_vid';
  var LEGACY_SENT_KEY = '_cufc_legacy_sent';

  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function getCookie(name) {
    var raw = document.cookie || '';
    var parts = raw ? raw.split('; ') : [];
    for (var i = 0; i < parts.length; i++) {
      var c = parts[i];
      var eq = c.indexOf('=');
      var k = eq > -1 ? c.slice(0, eq) : c;
      if (k === name) {
        var v = eq > -1 ? c.slice(eq + 1) : '';
        try { return decodeURIComponent(v); } catch (e) { return v; }
      }
    }
    return null;
  }

  function lsGet(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, val); } catch (e) {}
  }

  // Visitor id resolution:
  //   1. Prefer the server-set usg_vid cookie (the new spine).
  //   2. Fall back to the legacy _cufc_vid in localStorage.
  //   3. Otherwise mint a fresh id and persist it as the legacy fallback.
  // When we switch a returning visitor from a legacy id onto usg_vid, we send the
  // old id ONCE as `legacyVid` so the server can stitch the two histories together.
  function resolveVisitor() {
    var cookieVid = getCookie(VID_COOKIE);
    var legacyVid = lsGet(LEGACY_VID_KEY);
    var visitorId, legacyToSend = null;
    if (cookieVid) {
      visitorId = cookieVid;
      if (legacyVid && legacyVid !== cookieVid && !lsGet(LEGACY_SENT_KEY)) {
        legacyToSend = legacyVid;
      }
    } else if (legacyVid) {
      visitorId = legacyVid;
    } else {
      visitorId = uuid();
      lsSet(LEGACY_VID_KEY, visitorId);
    }
    return { visitorId: visitorId, legacyVid: legacyToSend };
  }

  function getSessionId() {
    var id = sessionStorage.getItem('_cufc_sid');
    if (!id) { id = uuid(); sessionStorage.setItem('_cufc_sid', id); }
    return id;
  }

  function getDevice() {
    var w = window.innerWidth;
    if (w < 768) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  }

  function getBrowser() {
    var ua = navigator.userAgent;
    if (ua.indexOf('Chrome') > -1 && ua.indexOf('Edg') === -1) return 'Chrome';
    if (ua.indexOf('Safari') > -1 && ua.indexOf('Chrome') === -1) return 'Safari';
    if (ua.indexOf('Firefox') > -1) return 'Firefox';
    if (ua.indexOf('Edg') > -1) return 'Edge';
    return 'Other';
  }

  function getUTM() {
    var params = new URLSearchParams(window.location.search);
    return {
      utmSource: params.get('utm_source') || null,
      utmMedium: params.get('utm_medium') || null,
      utmCampaign: params.get('utm_campaign') || null,
      utmContent: params.get('utm_content') || null,
      utmTerm: params.get('utm_term') || null
    };
  }

  function getCampSlug() {
    var path = window.location.pathname;
    if (path === '/' || path.startsWith('/admin') || path.startsWith('/login') || path.startsWith('/api')) return null;
    var parts = path.split('/').filter(Boolean);
    var skipPaths = ['login', 'admin', 'api', 'auth', 'settings', 'register'];
    if (parts.length >= 1 && skipPaths.indexOf(parts[0]) === -1) return parts[0];
    return null;
  }

  function getTrafficSource() {
    if (utm.utmSource) {
      if (utm.utmSource.toLowerCase().indexOf('facebook') > -1 || utm.utmSource.toLowerCase().indexOf('meta') > -1 || utm.utmSource.toLowerCase().indexOf('instagram') > -1) return 'Meta Ads';
      if (utm.utmSource.toLowerCase().indexOf('google') > -1) return 'Google Ads';
      return utm.utmSource;
    }
    var ref = document.referrer;
    if (!ref) return 'Direct';
    if (ref.indexOf('facebook.com') > -1 || ref.indexOf('instagram.com') > -1) return 'Meta Organic';
    if (ref.indexOf('google.') > -1) return 'Organic Search';
    if (ref.indexOf('bing.') > -1) return 'Organic Search';
    if (ref.indexOf(window.location.hostname) > -1) return 'Internal';
    return 'Referral';
  }

  var visitor = resolveVisitor();
  var visitorId = visitor.visitorId;
  var legacyVidToSend = visitor.legacyVid;
  var sessionId = getSessionId();
  var utm = getUTM();

  // Attribution touch fields — captured once from the landing URL/cookies at boot.
  var landingParams = new URLSearchParams(window.location.search);
  var fbclid = landingParams.get('fbclid') || null;
  var gclid = landingParams.get('gclid') || null;
  var ciParam = landingParams.get('ci') || null;
  // Click id: the ?ci= on this landing wins; else the server-set usg_cid (last click).
  var clickId = ciParam || getCookie(CID_COOKIE) || null;
  var fbp = getCookie('_fbp');
  var fbc = getCookie('_fbc');
  var landingUrl = window.location.href;

  var isNewSession = !sessionStorage.getItem('_cufc_session_started');
  var pageLoadTime = Date.now();
  var maxScroll = 0;
  var hasInteracted = false;
  var eventQueue = [];
  var flushTimer = null;

  // Full attribution bundle attached to session_start / page_view payloads only
  // (touch-bearing events — clicks/scroll/exit stay lean).
  function applyAttribution(evt) {
    evt.utmContent = utm.utmContent;
    evt.utmTerm = utm.utmTerm;
    evt.fbclid = fbclid;
    evt.gclid = gclid;
    evt.ci = ciParam;
    evt.clickId = clickId;
    evt.fbp = fbp;
    evt.fbc = fbc;
    evt.landingUrl = landingUrl;
    // navigator.webdriver hint — the server ORs this into its bot flag (T6).
    evt.webdriver = (navigator.webdriver === true);
    if (legacyVidToSend) evt.legacyVid = legacyVidToSend;
  }

  function queueEvent(eventType, metadata) {
    var evt = {
      visitorId: visitorId,
      sessionId: sessionId,
      eventType: eventType,
      page: window.location.pathname,
      referrer: document.referrer || null,
      utmSource: utm.utmSource,
      utmMedium: utm.utmMedium,
      utmCampaign: utm.utmCampaign,
      device: getDevice(),
      browser: getBrowser(),
      screenWidth: window.innerWidth,
      campSlug: getCampSlug(),
      metadata: metadata || null
    };
    if (eventType === 'session_start' || eventType === 'page_view') {
      applyAttribution(evt);
    }
    eventQueue.push(evt);
    if (!flushTimer) {
      flushTimer = setTimeout(flushEvents, 2000);
    }
  }

  function flushEvents() {
    flushTimer = null;
    if (eventQueue.length === 0) return;
    var events = eventQueue.splice(0, eventQueue.length);
    try {
      var payload = JSON.stringify({ events: events });
      if (navigator.sendBeacon) {
        var blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon(BATCH_ENDPOINT, blob);
      } else {
        fetch(BATCH_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true });
      }
    } catch(e) {}
  }

  if (isNewSession) {
    sessionStorage.setItem('_cufc_session_started', '1');
    queueEvent('session_start', { trafficSource: getTrafficSource(), isNewVisitor: !localStorage.getItem('_cufc_returning') });
    localStorage.setItem('_cufc_returning', '1');
  }

  queueEvent('page_view', { trafficSource: getTrafficSource() });

  // The legacy-id stitch signal is sent once per browser: after the initial
  // session_start/page_view carry it, mark it sent and stop attaching it.
  if (legacyVidToSend) {
    lsSet(LEGACY_SENT_KEY, '1');
    legacyVidToSend = null;
  }

  var lastPath = window.location.pathname;
  setInterval(function() {
    var currentPath = window.location.pathname;
    if (currentPath !== lastPath) {
      lastPath = currentPath;
      var slug = getCampSlug();
      if (slug) {
        queueEvent('page_view', { trafficSource: getTrafficSource() });
      }
    }
  }, 1000);

  window.addEventListener('scroll', function() {
    var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    var docHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) - window.innerHeight;
    if (docHeight > 0) {
      var pct = Math.round((scrollTop / docHeight) * 100);
      if (pct > maxScroll) maxScroll = pct;
    }
    hasInteracted = true;
  }, { passive: true });

  document.addEventListener('click', function(e) {
    hasInteracted = true;
    var target = e.target;
    var el = target.closest ? target.closest('a, button, [data-testid]') : target;
    if (!el) return;
    var testid = el.getAttribute('data-testid') || '';
    var text = (el.textContent || '').trim().substring(0, 80);
    var tag = el.tagName.toLowerCase();
    var href = el.getAttribute('href') || '';

    if (testid.indexOf('cta') > -1 || testid.indexOf('register') > -1 || testid.indexOf('book') > -1 ||
        text.toLowerCase().indexOf('register') > -1 || text.toLowerCase().indexOf('book now') > -1 ||
        text.toLowerCase().indexOf('enrol') > -1 || text.toLowerCase().indexOf('sign up') > -1 ||
        (href && href.indexOf('/book') > -1)) {
      queueEvent('cta_click', { element: tag, testid: testid, text: text, href: href, x: e.clientX, y: e.clientY });
    }

    queueEvent('click', { element: tag, testid: testid, text: text, href: href, x: e.clientX, y: e.clientY, scrollY: window.pageYOffset });
  });

  window._cufc_track = function(eventType, metadata) {
    queueEvent(eventType, metadata);
  };

  function sendExitEvents() {
    var timeOnPage = Math.round((Date.now() - pageLoadTime) / 1000);
    queueEvent('time_on_page', { seconds: timeOnPage });
    queueEvent('scroll_depth', { maxPercent: maxScroll });
    if (!hasInteracted && timeOnPage < 10) {
      queueEvent('bounce', {});
    }
    flushEvents();
  }

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'hidden') sendExitEvents();
  });
  window.addEventListener('beforeunload', sendExitEvents);

  if (window.location.pathname.indexOf('/book') > -1) {
    queueEvent('form_view', {});
    var observer = new MutationObserver(function() {
      var steps = document.querySelectorAll('[data-step]');
      if (steps.length > 0) {
        steps.forEach(function(s) {
          if (!s._tracked) {
            s._tracked = true;
            var step = s.getAttribute('data-step');
            queueEvent('form_step', { step: step });
          }
        });
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
