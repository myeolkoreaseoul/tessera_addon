#!/usr/bin/env python3
"""Kiwi 사용 가이드 PDF 생성"""
from fpdf import FPDF
import os

FONT_PATH = os.path.expanduser("~/.local/share/fonts/NotoSansKR.ttf")
ICON_PATH = os.path.join(os.path.dirname(__file__), "..", "build", "icon.png")
OUT_PATH = os.path.join(os.path.dirname(__file__), "Kiwi_사용가이드.pdf")


class KiwiPDF(FPDF):
    def __init__(self):
        super().__init__()
        self.add_font("noto", "", FONT_PATH)
        self.add_font("noto", "B", FONT_PATH)
        self.set_auto_page_break(auto=True, margin=20)

    def header(self):
        if self.page_no() > 1:
            self.set_font("noto", "", 8)
            self.set_text_color(150, 150, 150)
            self.cell(0, 8, "Kiwi 사용 가이드", align="L")
            self.cell(0, 8, f"- {self.page_no()} -", align="R", new_x="LMARGIN", new_y="NEXT")
            self.line(10, 18, 200, 18)
            self.ln(4)

    def title_page(self):
        self.add_page()
        self.ln(40)
        # icon
        if os.path.exists(ICON_PATH):
            self.image(ICON_PATH, x=80, y=45, w=50)
        self.ln(55)
        self.set_font("noto", "B", 28)
        self.set_text_color(45, 106, 79)
        self.cell(0, 15, "Kiwi", align="C", new_x="LMARGIN", new_y="NEXT")
        self.set_font("noto", "", 14)
        self.set_text_color(100, 100, 100)
        self.cell(0, 10, "이지바로 집행내역 다운로드 도구", align="C", new_x="LMARGIN", new_y="NEXT")
        self.ln(5)
        self.set_font("noto", "", 11)
        self.cell(0, 8, "사용 가이드 v1.0", align="C", new_x="LMARGIN", new_y="NEXT")
        self.ln(40)
        self.set_font("noto", "", 10)
        self.set_text_color(130, 130, 130)
        self.cell(0, 7, "정동회계법인", align="C", new_x="LMARGIN", new_y="NEXT")
        self.cell(0, 7, "2026년 3월", align="C", new_x="LMARGIN", new_y="NEXT")

    def section_title(self, num, title):
        self.ln(6)
        self.set_font("noto", "B", 16)
        self.set_text_color(45, 106, 79)
        self.cell(0, 12, f"{num}. {title}", new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(45, 106, 79)
        self.line(10, self.get_y(), 200, self.get_y())
        self.ln(4)

    def sub_title(self, title):
        self.ln(3)
        self.set_font("noto", "B", 12)
        self.set_text_color(60, 60, 60)
        self.cell(0, 9, title, new_x="LMARGIN", new_y="NEXT")
        self.ln(1)

    def body(self, text):
        self.set_x(10)
        self.set_font("noto", "", 10)
        self.set_text_color(50, 50, 50)
        self.multi_cell(190, 7, text)
        self.ln(2)

    def step(self, num, text):
        self.set_x(10)
        self.set_font("noto", "B", 10)
        self.set_text_color(45, 106, 79)
        self.cell(8, 7, str(num), align="C")
        self.set_font("noto", "", 10)
        self.set_text_color(50, 50, 50)
        self.multi_cell(172, 7, f"  {text}")
        self.ln(1)

    def _colored_box(self, label, text, fill_rgb, border_rgb, label_rgb, text_rgb):
        self.ln(2)
        self.set_x(10)
        self.set_font("noto", "B", 9)
        # measure height first
        label_w = self.get_string_width(label + "  ") + 4
        self.set_font("noto", "", 9)
        y_start = self.get_y()
        # draw label + text
        self.set_fill_color(*fill_rgb)
        self.set_draw_color(*border_rgb)
        self.set_xy(10, y_start)
        self.set_font("noto", "B", 9)
        self.set_text_color(*label_rgb)
        self.cell(190, 7, f"  {label}", fill=True, border="LRT", new_x="LMARGIN", new_y="NEXT")
        self.set_x(10)
        self.set_font("noto", "", 9)
        self.set_text_color(*text_rgb)
        self.multi_cell(190, 6, f"  {text}", fill=True, border="LRB")
        self.ln(3)

    def tip_box(self, text):
        self._colored_box("TIP", text, (240, 250, 244), (45, 106, 79), (45, 106, 79), (60, 60, 60))

    def warning_box(self, text):
        self._colored_box("주의", text, (255, 243, 224), (230, 81, 0), (230, 81, 0), (80, 60, 40))

    def bullet(self, text):
        self.set_x(10)
        self.set_font("noto", "", 10)
        self.set_text_color(50, 50, 50)
        self.cell(6, 7, "•")
        self.multi_cell(184, 7, f" {text}")
        self.ln(1)


def build():
    pdf = KiwiPDF()

    # --- 표지 ---
    pdf.title_page()

    # --- 목차 ---
    pdf.add_page()
    pdf.set_font("noto", "B", 18)
    pdf.set_text_color(45, 106, 79)
    pdf.cell(0, 15, "목차", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(10)
    toc = [
        ("1", "프로그램 설치", "3"),
        ("2", "처음 실행하기", "4"),
        ("3", "사용 방법 (전체 흐름)", "5"),
        ("4", "각 단계 상세 설명", "6"),
        ("5", "자주 묻는 질문 (FAQ)", "9"),
        ("6", "문제 해결", "10"),
    ]
    for num, title, pg in toc:
        pdf.set_font("noto", "", 12)
        pdf.set_text_color(50, 50, 50)
        pdf.cell(10, 10, num + ".")
        pdf.cell(140, 10, title)
        pdf.set_text_color(150, 150, 150)
        pdf.cell(0, 10, pg, align="R", new_x="LMARGIN", new_y="NEXT")

    # === 1. 설치 ===
    pdf.add_page()
    pdf.section_title("1", "프로그램 설치")

    pdf.sub_title("설치 파일 받기")
    pdf.body("바탕화면에 있는 'Kiwi-Setup-1.0.3.exe' 파일을 더블클릭합니다.")
    pdf.body("(파일이 없다면 담당자에게 요청하세요)")

    pdf.sub_title("'Windows의 PC 보호' 화면이 나올 때")
    pdf.body("처음 설치할 때 파란색 경고 화면이 나타날 수 있습니다. 이것은 정상입니다.")
    pdf.step(1, "'추가 정보' 글자를 클릭합니다.")
    pdf.step(2, "'실행' 버튼이 나타나면 클릭합니다.")
    pdf.step(3, "설치가 진행됩니다.")
    pdf.tip_box("이 경고는 프로그램에 상용 인증서가 없을 때 나타나는 Windows 기본 동작입니다. 한 번만 허용하면 이후에는 나타나지 않습니다.")

    pdf.sub_title("설치 경로 선택")
    pdf.body("기본 경로 그대로 '설치' 버튼을 누르면 됩니다. 특별히 바꿀 필요 없습니다.")

    # === 2. 처음 실행 ===
    pdf.add_page()
    pdf.section_title("2", "처음 실행하기")
    pdf.body("설치가 완료되면 바탕화면 또는 시작 메뉴에서 'Kiwi'를 실행합니다.")
    pdf.body("실행하면 아래와 같은 화면이 나타납니다:")
    pdf.ln(3)

    # 화면 구성 설명
    pdf.sub_title("화면 구성")
    pdf.set_font("noto", "", 10)
    pdf.set_text_color(50, 50, 50)

    # 박스로 화면 구성 표현
    pdf.set_fill_color(45, 106, 79)
    pdf.set_text_color(255, 255, 255)
    pdf.set_font("noto", "B", 11)
    pdf.cell(190, 10, "  Kiwi — 이지바로 집행내역 다운로드 v1.0.3", fill=True, new_x="LMARGIN", new_y="NEXT")

    sections = [
        ("저장 위치", "다운로드한 파일이 저장될 폴더를 지정합니다."),
        ("1  브라우저", "이지바로 접속에 사용할 Chrome을 실행합니다."),
        ("2  과제 목록", "다운로드할 과제가 적힌 엑셀 파일을 올립니다."),
        ("3  실행", "시작 버튼을 누르면 자동으로 다운로드가 진행됩니다."),
    ]
    for title, desc in sections:
        pdf.set_fill_color(245, 247, 250)
        pdf.set_draw_color(224, 224, 224)
        pdf.set_text_color(45, 106, 79)
        pdf.set_font("noto", "B", 10)
        pdf.cell(190, 8, f"  {title}", fill=True, border="LRT", new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(100, 100, 100)
        pdf.set_font("noto", "", 9)
        pdf.cell(190, 7, f"    {desc}", fill=True, border="LRB", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    pdf.set_text_color(50, 50, 50)
    pdf.body("위에서 아래로 순서대로 진행하면 됩니다.")

    # === 3. 전체 흐름 ===
    pdf.add_page()
    pdf.section_title("3", "사용 방법 (전체 흐름)")
    pdf.body("Kiwi 사용은 4단계로 이루어집니다. 아래 순서대로 따라 하세요.")
    pdf.ln(5)

    steps = [
        ("저장 위치 지정", "다운로드할 파일이 저장될 폴더를 선택합니다.\n(예: 바탕화면의 '집행내역' 폴더)"),
        ("브라우저 열기 + 이지바로 로그인", "'브라우저 열기' 버튼 클릭 → Chrome이 열림\n→ 이지바로 로그인 → 정산 → 상시점검 → 상시점검 관리"),
        ("엑셀 파일 업로드", "다운로드할 과제 목록이 적힌 엑셀 파일을 끌어다 놓거나 클릭해서 선택합니다."),
        ("시작 버튼 클릭", "'시작' 버튼을 누르면 자동으로 각 과제의 집행내역을 다운로드합니다.\n완료될 때까지 기다리면 됩니다."),
    ]
    for i, (title, desc) in enumerate(steps, 1):
        pdf.set_fill_color(45, 106, 79)
        pdf.set_text_color(255, 255, 255)
        pdf.set_font("noto", "B", 12)
        y = pdf.get_y()
        pdf.cell(10, 10, f" {i}", fill=True, align="C")
        pdf.set_text_color(45, 106, 79)
        pdf.set_font("noto", "B", 12)
        pdf.cell(0, 10, f"  {title}", new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(80, 80, 80)
        pdf.set_font("noto", "", 10)
        pdf.set_x(24)
        pdf.multi_cell(166, 7, desc)
        pdf.ln(4)

    pdf.tip_box("전체 과정은 보통 5~10분 정도 소요됩니다. (과제 수에 따라 다름)")

    # === 4. 상세 설명 ===
    pdf.add_page()
    pdf.section_title("4", "각 단계 상세 설명")

    pdf.sub_title("4-1. 저장 위치 지정")
    pdf.body("'변경' 버튼을 클릭하면 폴더 선택 창이 뜹니다.")
    pdf.bullet("원하는 폴더를 선택하고 '확인'을 누릅니다.")
    pdf.bullet("폴더가 없으면 새로 만들어도 됩니다.")
    pdf.bullet("한 번 지정하면 다음에 실행할 때도 기억됩니다.")
    pdf.tip_box("바탕화면에 '집행내역' 같은 이름으로 폴더를 하나 만들어 사용하시는 것을 추천합니다.")

    pdf.sub_title("4-2. 브라우저 열기")
    pdf.step(1, "'브라우저 열기' 버튼을 클릭합니다.")
    pdf.step(2, "Chrome이 자동으로 열리면서 이지바로 메인 페이지가 나타납니다.")
    pdf.step(3, "이지바로에 본인 계정으로 로그인합니다.")
    pdf.step(4, "왼쪽 메뉴에서 '정산 → 상시점검 → 상시점검 관리'로 이동합니다.")
    pdf.step(5, "상시점검 관리 화면이 보이면 Kiwi로 돌아옵니다.")
    pdf.warning_box("반드시 Kiwi에서 열린 Chrome에서 로그인해야 합니다. 기존에 열려있던 Chrome은 사용할 수 없습니다.")

    pdf.sub_title("4-3. 엑셀 파일 업로드")
    pdf.body("다운로드할 과제 목록이 담긴 엑셀(.xlsx) 파일을 준비합니다.")
    pdf.step(1, "엑셀 파일을 Kiwi 화면의 점선 영역에 끌어다 놓습니다.")
    pdf.body("또는 점선 영역을 클릭해서 파일을 직접 선택할 수도 있습니다.")
    pdf.step(2, "파일이 정상적으로 읽히면 과제 목록이 테이블로 표시됩니다.")
    pdf.step(3, "과제번호, 연구수행기관, 연구책임자가 맞는지 확인합니다.")

    pdf.sub_title("엑셀 파일 형식")
    pdf.body("엑셀 파일에는 다음 열이 포함되어 있어야 합니다:")
    pdf.bullet("C열 (3번째): 사업년도")
    pdf.bullet("D열 (4번째): 과제번호")
    pdf.bullet("Q열 (17번째): 연구수행기관")
    pdf.bullet("T열 (20번째): 연구책임자")
    pdf.body("첫 번째 행은 헤더(제목)로 인식되어 건너뜁니다.")

    pdf.add_page()
    pdf.sub_title("4-4. 시작")
    pdf.body("저장 위치, 브라우저 연결, 과제 목록이 모두 준비되면 '시작' 버튼이 활성화됩니다.")
    pdf.step(1, "'시작' 버튼을 클릭합니다.")
    pdf.step(2, "프로그램이 자동으로 각 과제를 검색하고 집행내역을 다운로드합니다.")
    pdf.step(3, "진행 상황이 테이블과 진행바에 실시간으로 표시됩니다.")
    pdf.step(4, "모든 과제가 완료되면 '폴더 열기' 버튼이 나타납니다.")

    pdf.sub_title("다운로드된 파일")
    pdf.body("파일은 아래 형식으로 저장됩니다:")
    pdf.ln(2)
    pdf.set_fill_color(245, 245, 245)
    pdf.set_draw_color(200, 200, 200)
    pdf.set_font("noto", "B", 11)
    pdf.set_text_color(45, 106, 79)
    pdf.cell(190, 10, "  과제번호_연구수행기관_연구책임자.xlsx", fill=True, border=1, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)
    pdf.set_text_color(50, 50, 50)
    pdf.set_font("noto", "", 10)
    pdf.body("예시: 2024M1A3B2081234_한국과학기술연구원_홍길동.xlsx")

    pdf.sub_title("상태 표시")
    statuses = [
        ("대기", "#e0e0e0", "아직 처리되지 않은 과제"),
        ("진행중", "#fff3e0", "현재 다운로드 중인 과제"),
        ("완료", "#e8f5e9", "다운로드 성공"),
        ("실패", "#ffebee", "다운로드 실패 (마우스를 올리면 사유 표시)"),
    ]
    for name, _, desc in statuses:
        pdf.set_font("noto", "B", 10)
        pdf.cell(20, 7, f"  {name}")
        pdf.set_font("noto", "", 10)
        pdf.cell(0, 7, f"  — {desc}", new_x="LMARGIN", new_y="NEXT")

    pdf.tip_box("다운로드 중에 '중지' 버튼을 누르면 진행을 멈출 수 있습니다. 이미 완료된 파일은 그대로 유지됩니다.")

    # === 5. FAQ ===
    pdf.add_page()
    pdf.section_title("5", "자주 묻는 질문 (FAQ)")

    faqs = [
        ("Q. 이전에 다운로드한 파일이 있으면 어떻게 되나요?",
         "같은 이름의 파일이 이미 저장 폴더에 있으면 자동으로 건너뜁니다. 다시 받고 싶으면 해당 파일을 삭제한 뒤 다시 시작하세요."),
        ("Q. 도중에 인터넷이 끊기면?",
         "해당 과제는 '실패'로 표시됩니다. 나머지 과제는 계속 진행됩니다. 실패한 과제는 프로그램을 다시 실행해서 같은 엑셀을 올리면 됩니다. (이미 받은 것은 건너뜀)"),
        ("Q. 엑셀에 과제번호가 잘못 적혀 있으면?",
         "이지바로에서 해당 과제를 찾지 못해 '실패'로 표시됩니다. 엑셀을 수정한 후 다시 시도하세요."),
        ("Q. 여러 명이 동시에 사용해도 되나요?",
         "각자 PC에 Kiwi를 설치해서 사용할 수 있습니다. 다만 같은 이지바로 계정으로 동시 로그인은 이지바로 정책에 따릅니다."),
        ("Q. 다른 엑셀 파일로 바꾸고 싶으면?",
         "새 엑셀 파일을 다시 끌어다 놓으면 이전 목록이 대체됩니다."),
        ("Q. 저장 폴더를 바꾸고 싶으면?",
         "'변경' 버튼을 클릭해서 새 폴더를 선택하면 됩니다."),
    ]
    for q, a in faqs:
        pdf.set_x(10)
        pdf.set_font("noto", "B", 10)
        pdf.set_text_color(45, 106, 79)
        pdf.multi_cell(190, 7, q)
        pdf.set_x(10)
        pdf.set_font("noto", "", 10)
        pdf.set_text_color(80, 80, 80)
        pdf.multi_cell(190, 7, a)
        pdf.ln(4)

    # === 6. 문제 해결 ===
    pdf.add_page()
    pdf.section_title("6", "문제 해결")

    problems = [
        ("'시작' 버튼이 눌리지 않아요",
         [
             "저장 위치가 지정되어 있는지 확인하세요. ('설정되지 않음'이면 안 됩니다)",
             "브라우저 상태가 '연결됨'인지 확인하세요. (초록색 점)",
             "엑셀 파일이 업로드되어 과제 목록이 표시되는지 확인하세요.",
             "세 가지가 모두 준비되어야 시작 버튼이 활성화됩니다.",
         ]),
        ("브라우저가 열리지 않아요",
         [
             "Chrome이 PC에 설치되어 있는지 확인하세요.",
             "이미 열려있는 Chrome을 모두 닫고 다시 시도하세요.",
             "작업 관리자(Ctrl+Shift+Esc)에서 chrome.exe를 모두 종료한 후 다시 시도하세요.",
         ]),
        ("다운로드가 실패해요",
         [
             "이지바로에 로그인이 되어 있는지 확인하세요.",
             "'상시점검 관리' 화면에 있는지 확인하세요.",
             "인터넷 연결을 확인하세요.",
             "실패한 과제의 상태 배지에 마우스를 올리면 실패 사유를 볼 수 있습니다.",
         ]),
        ("파일명이 깨져 보여요",
         [
             "v1.0.2 이상 버전을 사용하고 있는지 확인하세요.",
             "헤더에 표시된 버전을 확인하세요.",
         ]),
    ]
    for title, items in problems:
        pdf.set_font("noto", "B", 11)
        pdf.set_text_color(50, 50, 50)
        pdf.cell(0, 9, title, new_x="LMARGIN", new_y="NEXT")
        for item in items:
            pdf.bullet(item)
        pdf.ln(3)

    pdf.ln(10)
    pdf.set_draw_color(200, 200, 200)
    pdf.line(10, pdf.get_y(), 200, pdf.get_y())
    pdf.ln(5)
    pdf.set_font("noto", "", 9)
    pdf.set_text_color(150, 150, 150)
    pdf.cell(0, 7, "문의: 담당자에게 연락하세요.", align="C", new_x="LMARGIN", new_y="NEXT")
    pdf.cell(0, 7, "Kiwi v1.0.3 | 정동회계법인 | 2026년 3월", align="C", new_x="LMARGIN", new_y="NEXT")

    pdf.output(OUT_PATH)
    print(f"PDF 생성 완료: {OUT_PATH}")
    print(f"페이지 수: {pdf.page_no()}")


if __name__ == "__main__":
    build()
