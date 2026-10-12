/** Product dependencies, including xeCJK's required CTeX support files.
 * Package managers resolve the remaining transitive dependencies.
 */
export const requiredFonts = Object.freeze([
  'Lato/Lato-Regular.ttf', 'Lato/Lato-Bold.ttf', 'Lato/Lato-Italic.ttf', 'Lato/Lato-BoldItalic.ttf',
  'Simsun/SourceHanSerifCN-Regular.ttf', 'Simsun/SourceHanSerifCN-Bold.ttf',
]);
export const requiredProjectFiles = Object.freeze([
  ...requiredFonts.map(file => `font/${file}`), 'font/Lato/OFL.txt', 'font/Simsun/LICENSE.txt',
  'templates/purecv-en/main.tex', 'templates/purecv-zh/main.tex', 'templates/shared/macros.tex',
  'resume/uestc.png', 'resume_zh/uestc.png',
]);
export const requiredTexFiles = Object.freeze([
  'article.cls', 'geometry.sty', 'fontspec.sty', 'xeCJK.sty', 'ctexhook.sty', 'ctexpatch.sty', 'titlesec.sty', 'enumitem.sty',
  'tabularx.sty', 'array.sty', 'graphicx.sty', 'hyperref.sty', 'accsupp.sty',
]);
export const packageIdsByFlavour = Object.freeze({
  miktex: Object.freeze({ 'article.cls': 'ltxbase', 'geometry.sty': 'geometry', 'fontspec.sty': 'fontspec',
    'xeCJK.sty': 'xecjk', 'ctexhook.sty': 'ctex', 'ctexpatch.sty': 'ctex',
    'titlesec.sty': 'titlesec', 'enumitem.sty': 'enumitem', 'tabularx.sty': 'latex-tools',
    'array.sty': 'latex-tools', 'graphicx.sty': 'graphics', 'hyperref.sty': 'hyperref', 'accsupp.sty': 'accsupp' }),
  texlive: Object.freeze({ 'article.cls': 'latex', 'geometry.sty': 'geometry', 'fontspec.sty': 'fontspec',
    'xeCJK.sty': 'xecjk', 'ctexhook.sty': 'ctex', 'ctexpatch.sty': 'ctex',
    'titlesec.sty': 'titlesec', 'enumitem.sty': 'enumitem', 'tabularx.sty': 'tools',
    'array.sty': 'tools', 'graphicx.sty': 'graphics', 'hyperref.sty': 'hyperref', 'accsupp.sty': 'accsupp' }),
});
