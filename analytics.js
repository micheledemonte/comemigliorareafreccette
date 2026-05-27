// Vercel Web Analytics - Inline Injection
// This script initializes Vercel Web Analytics for page view tracking
(function() {
  'use strict';
  
  // Initialize the queue for analytics events
  if (!window.va) {
    window.va = function va() {
      var params = Array.prototype.slice.call(arguments);
      if (!window.vaq) window.vaq = [];
      window.vaq.push(params);
    };
  }

  // Detect environment
  var mode = 'production';
  
  if (!window.vam) {
    window.vam = mode;
  }
  
  // Create and inject the Vercel Analytics script
  var script = document.createElement('script');
  script.defer = true;
  script.src = '/_vercel/insights/script.js';
  
  // Append to document
  if (document.head) {
    document.head.appendChild(script);
  } else {
    // Fallback if head is not yet available
    document.addEventListener('DOMContentLoaded', function() {
      document.head.appendChild(script);
    });
  }
})();
