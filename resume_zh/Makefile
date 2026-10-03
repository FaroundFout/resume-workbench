TARGET = resume_zh
pdf: $(TARGET).pdf
$(TARGET).pdf: $(TARGET).tex custom-commands.tex $(wildcard src/*_zh.tex)
	xelatex $(TARGET).tex
clean:
	-rm -f *.aux *.log *.out $(TARGET).pdf
