from PyPDF2 import PdfReader

reader = PdfReader('d:/IoT_Project/doc/IoT_Project_SADD.pdf')
text = ''
for i, page in enumerate(reader.pages):
    text += f'--- Page {i+1} ---\n'
    text += page.extract_text() + '\n'

with open('d:/IoT_Project/doc/pdf_output.txt', 'w', encoding='utf-8') as f:
    f.write(text)
