import pathlib,sys,unittest
sys.path.insert(0,str(pathlib.Path(__file__).parent))
from preview import render

class PreviewTests(unittest.TestCase):
    def test_html_escapes_external_content(self):
        page=render([('<script>alert(1)</script>',175000,'أجهزة','https://example.org/item?x=1&y=2','source')])
        self.assertNotIn('<script>',page)
        self.assertIn('&lt;script&gt;',page)
        self.assertIn('&amp;y=2',page)
        self.assertIn('175,000 د.ع',page)
    def test_disallows_non_https_links(self):
        page=render([('bad',None,'other','javascript:alert(1)','unsafe')])
        self.assertNotIn('javascript:',page)
        self.assertIn('لا توجد عروض',page)
if __name__=='__main__':unittest.main()
