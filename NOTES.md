# Useful JS

*Get all internal links on page, sorted and unique*

```javascript
[...new Set([...document.querySelectorAll('a')].filter(a => a.href && a.hostname === location.hostname).map(a => { const u = new URL(a.href); u.hash = ''; return u.href; }).sort())]
```

*with link center*

```javascript
[...document.querySelectorAll('a')].filter(a => a.href && a.hostname === location.hostname).map(a => ({ el: {href: a.href, text: a.innerText}, rect: a.getBoundingClientRect() })).filter(x => x.rect.width > 0 && x.rect.height > 0).map(({ el, rect }) => { return { el, cx: Math.round(rect.left + rect.width / 2 + window.scrollX), cy: Math.round(rect.top + rect.height / 2 + window.scrollY), }; })
```

```json
[
  "https://turkbuilders.com/",
  "https://turkbuilders.com/about-us/",
  "https://turkbuilders.com/commitment/",
  "https://turkbuilders.com/contact-us/",
  "https://turkbuilders.com/feedback/",
  "https://turkbuilders.com/project-gallery/",
  "https://turkbuilders.com/sitemap/"
]
```

*external, groupd by host*

```javascript
Object.entries( [...document.querySelectorAll('a')] .filter(a => a.href.startsWith('http') && a.hostname !== location.hostname) .reduce((acc, a) => { (acc[a.hostname] ??= []).push({ href: a.href, text: a.textContent.trim() }); return acc; }, {}) )
```

```json
[
  [
    "www.oceanreefchamber.org",
    [
      {
        "href": "https://www.oceanreefchamber.org/",
        "text": ""
      },
      {
        "href": "https://www.oceanreefchamber.org/",
        "text": ""
      }
    ]
  ],
  [
    "www.southernlivingcustombuilder.com",
    [
      {
        "href": "https://www.southernlivingcustombuilder.com/",
        "text": ""
      },
      {
        "href": "https://www.southernlivingcustombuilder.com/",
        "text": ""
      }
    ]
  ],
  [
    "twitter.com",
    [
      {
        "href": "https://twitter.com/TurkBuilders",
        "text": ""
      }
    ]
  ],
  [
    "www.instagram.com",
    [
      {
        "href": "https://www.instagram.com/turkbuilders/",
        "text": ""
      }
    ]
  ]
]
```

*Get all images on the page, with size details*

```javascript
[...document.querySelectorAll('img')].map(img => ({ src: img.src, currentSrc: img.currentSrc, alt: img.alt, title: img.title, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, displayWidth: img.width, displayHeight: img.height, complete: img.complete, loading: img.loading, srcset: img.srcset, sizes: img.sizes, rect: img.getBoundingClientRect(), }))
```

```json
[
  {
    "src": "https://turkbuilders.com/wp-content/uploads/2018/11/OR-chamber-logo-white-3-300x120.png",
    "currentSrc": "https://turkbuilders.com/wp-content/uploads/2018/11/OR-chamber-logo-white-3-300x120.png",
    "alt": "",
    "title": "",
    "naturalWidth": 300,
    "naturalHeight": 120,
    "displayWidth": 63,
    "displayHeight": 25,
    "complete": true,
    "loading": "auto",
    "srcset": "",
    "sizes": "",
    "rect": {
      "x": 1164,
      "y": 18.703125,
      "width": 63,
      "height": 25.1953125,
      "top": 18.703125,
      "right": 1227,
      "bottom": 43.8984375,
      "left": 1164
    }
  },
  {
    "src": "https://turkbuilders.com/wp-content/uploads/2025/07/SLB-white@4x-300x109.png",
    "currentSrc": "https://turkbuilders.com/wp-content/uploads/2025/07/SLB-white@4x-300x109.png",
    "alt": "",
    "title": "",
    "naturalWidth": 300,
    "naturalHeight": 109,
    "displayWidth": 69,
    "displayHeight": 25,
    "complete": true,
    "loading": "auto",
    "srcset": "",
    "sizes": "",
    "rect": {
      "x": 1247,
      "y": 18.8046875,
      "width": 69,
      "height": 25.0625,
      "top": 18.8046875,
      "right": 1316,
      "bottom": 43.8671875,
      "left": 1247
    }
  },
  {
    "src": "https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-83x49.png",
    "currentSrc": "https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-300x178.png",
    "alt": "Turk Builders",
    "title": "",
    "naturalWidth": 83,
    "naturalHeight": 49,
    "displayWidth": 80,
    "displayHeight": 47,
    "complete": true,
    "loading": "auto",
    "srcset": "https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-83x49.png 83w, https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-300x178.png 300w, https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-768x455.png 768w, https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x.png 904w",
    "sizes": "(max-width: 83px) 100vw, 83px",
    "rect": {
      "x": 116,
      "y": 77,
      "width": 80,
      "height": 47.4609375,
      "top": 77,
      "right": 196,
      "bottom": 124.4609375,
      "left": 116
    }
  },
  {
    "src": "https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x.webp",
    "currentSrc": "https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x.webp",
    "alt": "",
    "title": "",
    "naturalWidth": 904,
    "naturalHeight": 535,
    "displayWidth": 904,
    "displayHeight": 535,
    "complete": true,
    "loading": "auto",
    "srcset": "https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x.webp 904w, https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-300x178.webp 300w, https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-768x455.webp 768w",
    "sizes": "(max-width: 904px) 100vw, 904px",
    "rect": {
      "x": 0,
      "y": 0,
      "width": 0,
      "height": 0,
      "top": 0,
      "right": 0,
      "bottom": 0,
      "left": 0
    }
  },
  {
    "src": "https://turkbuilders.com/wp-content/uploads/2018/11/OR-chamber-logo-white-3-300x120.png",
    "currentSrc": "https://turkbuilders.com/wp-content/uploads/2018/11/OR-chamber-logo-white-3-300x120.png",
    "alt": "",
    "title": "",
    "naturalWidth": 300,
    "naturalHeight": 120,
    "displayWidth": 63,
    "displayHeight": 25,
    "complete": true,
    "loading": "auto",
    "srcset": "",
    "sizes": "",
    "rect": {
      "x": 0,
      "y": 0,
      "width": 0,
      "height": 0,
      "top": 0,
      "right": 0,
      "bottom": 0,
      "left": 0
    }
  },
  {
    "src": "https://turkbuilders.com/wp-content/uploads/2025/07/SLB-white@4x-300x109.png",
    "currentSrc": "https://turkbuilders.com/wp-content/uploads/2025/07/SLB-white@4x-300x109.png",
    "alt": "",
    "title": "",
    "naturalWidth": 300,
    "naturalHeight": 109,
    "displayWidth": 69,
    "displayHeight": 25,
    "complete": true,
    "loading": "auto",
    "srcset": "",
    "sizes": "",
    "rect": {
      "x": 0,
      "y": 0,
      "width": 0,
      "height": 0,
      "top": 0,
      "right": 0,
      "bottom": 0,
      "left": 0
    }
  },
  {
    "src": "https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-83x49.png",
    "currentSrc": "https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-300x178.png",
    "alt": "Turk Builders",
    "title": "",
    "naturalWidth": 83,
    "naturalHeight": 49,
    "displayWidth": 83,
    "displayHeight": 49,
    "complete": true,
    "loading": "auto",
    "srcset": "https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-83x49.png 83w, https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-300x178.png 300w, https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-768x455.png 768w, https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x.png 904w",
    "sizes": "(max-width: 83px) 100vw, 83px",
    "rect": {
      "x": 0,
      "y": 0,
      "width": 0,
      "height": 0,
      "top": 0,
      "right": 0,
      "bottom": 0,
      "left": 0
    }
  },
  {
    "src": "https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x.webp",
    "currentSrc": "https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x.webp",
    "alt": "",
    "title": "",
    "naturalWidth": 904,
    "naturalHeight": 535,
    "displayWidth": 904,
    "displayHeight": 535,
    "complete": true,
    "loading": "auto",
    "srcset": "https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x.webp 904w, https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-300x178.webp 300w, https://turkbuilders.com/wp-content/uploads/2024/08/turk-logo-blue-green@2x-768x455.webp 768w",
    "sizes": "(max-width: 904px) 100vw, 904px",
    "rect": {
      "x": 0,
      "y": 0,
      "width": 0,
      "height": 0,
      "top": 0,
      "right": 0,
      "bottom": 0,
      "left": 0
    }
  }
]
```

*filter socials*

```javascript
const PATTERNS = {
  facebook: /(?:facebook|fb)\.com/i,
  instagram: /instagram\.com/i,
  youtube: /youtube\.com/i,
  tiktok: /tiktok\.com/i,
  x: /(?:twitter|x)\.com/i,
  linkedin: /linkedin\.com/i,
  yelp: /yelp\.com\/biz/i,
  tripadvisor: /tripadvisor\.com/i,
  google_maps: /(?:google\.com\/maps|maps\.google)/i,
  fishingbooker: /fishingbooker\.com/i,
  getmyboat: /getmyboat\.com/i,
};

Object.fromEntries(
  Object.entries(PATTERNS).map(([key, pattern]) => [
    key,
    ["https://twitter.com/TurkBuilders"].filter(h => pattern.test(h))
  ]).filter(([, v]) => v.length)
);
```