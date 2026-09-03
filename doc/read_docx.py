import zipfile
import xml.etree.ElementTree as ET

def extract_text_from_docx(path):
    word_schema = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    
    with zipfile.ZipFile(path) as docx:
        content = docx.read('word/document.xml')
        
    tree = ET.XML(content)
    paragraphs = []
    
    for p in tree.iter(f'{word_schema}p'):
        texts = [node.text for node in p.iter(f'{word_schema}t') if node.text]
        if texts:
            paragraphs.append(''.join(texts))
            
    return '\n'.join(paragraphs)

print(extract_text_from_docx('d:/IoT_Project/doc/Hardware.docx'))