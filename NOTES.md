# Useful JS

*Get all links on page, sorted and unique*

`[...new Set(Array.from(document.querySelectorAll('a')).filter(a => a.href).map(a => a.href.replace(/#.*$/,'')).sort())]`