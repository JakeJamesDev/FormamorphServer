#!/usr/bin/env python3
"""
Formamorph World Snapshot Viewer
A PyQt6 GUI application for browsing and extracting worlds from snapshot files.
"""

import sys
import json
import zipfile
from pathlib import Path
from io import BytesIO
from typing import Optional, List, Dict

from PyQt6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout,
    QPushButton, QLabel, QLineEdit, QListWidget, QListWidgetItem,
    QTextEdit, QFileDialog, QMessageBox, QSplitter, QScrollArea,
    QGridLayout, QFrame, QCheckBox, QGroupBox, QComboBox
)
from PyQt6.QtCore import Qt, QSize, pyqtSignal
from PyQt6.QtGui import QPixmap, QImage, QFont


class WorldCard(QFrame):
    """Custom widget for displaying a world card with thumbnail and info"""
    clicked = pyqtSignal(dict)
    
    def __init__(self, world_data: Dict, parent=None):
        super().__init__(parent)
        self.world_data = world_data
        self.setup_ui()
        
    def setup_ui(self):
        self.setFrameStyle(QFrame.Shape.Box | QFrame.Shadow.Raised)
        self.setLineWidth(2)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setMaximumWidth(200)
        
        layout = QVBoxLayout()
        layout.setSpacing(5)
        
        # Thumbnail placeholder
        self.thumbnail_label = QLabel()
        self.thumbnail_label.setFixedSize(180, 180)
        self.thumbnail_label.setScaledContents(True)
        self.thumbnail_label.setStyleSheet("background-color: #2a2a2a; border: 1px solid #444;")
        self.thumbnail_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.thumbnail_label.setText("Loading...")
        layout.addWidget(self.thumbnail_label)
        
        # World name
        name_label = QLabel(self.world_data['name'])
        name_label.setWordWrap(True)
        name_label.setFont(QFont('Arial', 10, QFont.Weight.Bold))
        name_label.setMaximumHeight(40)
        layout.addWidget(name_label)
        
        # Author
        author_label = QLabel(f"by {self.world_data['author']['username']}")
        author_label.setStyleSheet("color: #888;")
        layout.addWidget(author_label)
        
        # Stats
        stats_label = QLabel(f"↓ {self.world_data['downloads']} | 💬 {self.world_data['commentCount']}")
        stats_label.setStyleSheet("color: #666;")
        layout.addWidget(stats_label)
        
        self.setLayout(layout)
        
    def set_thumbnail(self, pixmap: QPixmap):
        """Set the thumbnail image"""
        if pixmap:
            scaled_pixmap = pixmap.scaled(
                180, 180,
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.SmoothTransformation
            )
            self.thumbnail_label.setPixmap(scaled_pixmap)
        else:
            self.thumbnail_label.setText("No Thumbnail")
            
    def mousePressEvent(self, event):
        """Handle card click"""
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self.world_data)
        super().mousePressEvent(event)


class SnapshotViewer(QMainWindow):
    def __init__(self):
        super().__init__()
        self.snapshot_file: Optional[zipfile.ZipFile] = None
        self.snapshot_path: Optional[str] = None
        self.metadata: Optional[Dict] = None
        self.filtered_worlds: List[Dict] = []
        self.current_world: Optional[Dict] = None
        self.world_cards: List[WorldCard] = []
        
        self.init_ui()
        
    def init_ui(self):
        """Initialize the user interface"""
        self.setWindowTitle('Formamorph World Snapshot Viewer')
        self.setGeometry(100, 100, 1200, 800)
        
        # Central widget
        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        
        # Main layout
        main_layout = QVBoxLayout()
        central_widget.setLayout(main_layout)
        
        # Top bar - File selection and info
        top_bar = self.create_top_bar()
        main_layout.addWidget(top_bar)
        
        # Search and filter bar
        search_bar = self.create_search_bar()
        main_layout.addWidget(search_bar)
        
        # Main content area (splitter for world list and details)
        splitter = QSplitter(Qt.Orientation.Horizontal)
        
        # Left: Worlds grid
        self.worlds_scroll = self.create_worlds_grid()
        splitter.addWidget(self.worlds_scroll)
        
        # Right: World details
        self.details_panel = self.create_details_panel()
        splitter.addWidget(self.details_panel)
        
        splitter.setSizes([700, 500])
        main_layout.addWidget(splitter)
        
        # Status bar
        self.statusBar().showMessage('No snapshot loaded')
        
    def create_top_bar(self) -> QWidget:
        """Create the top bar with file selection"""
        self.top_bar_widget = QWidget()
        layout = QHBoxLayout()
        layout.setContentsMargins(5, 5, 5, 5)
        
        # Open snapshot button
        self.open_btn = QPushButton('Open Snapshot')
        self.open_btn.clicked.connect(self.open_snapshot)
        layout.addWidget(self.open_btn)
        
        self.top_bar_widget.setLayout(layout)
        return self.top_bar_widget

        
    def create_search_bar(self) -> QWidget:
        """Create the search and filter bar"""
        widget = QWidget()
        widget.setMaximumHeight(35)
        layout = QHBoxLayout()
        layout.setContentsMargins(5, 2, 5, 2)
        layout.setSpacing(8)
        
        # Search field with compact label
        search_label = QLabel('Search:')
        search_label.setMaximumWidth(50)
        layout.addWidget(search_label)
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText('Name, description, tags...')
        self.search_input.setMaximumHeight(25)
        self.search_input.textChanged.connect(self.apply_filters)
        layout.addWidget(self.search_input, stretch=2)
        
        # Tag filter with compact label
        tag_label = QLabel('Tags:')
        tag_label.setMaximumWidth(40)
        layout.addWidget(tag_label)
        self.tag_input = QLineEdit()
        self.tag_input.setPlaceholderText('Comma-separated...')
        self.tag_input.setMaximumHeight(25)
        self.tag_input.textChanged.connect(self.apply_filters)
        layout.addWidget(self.tag_input, stretch=1)
        
        # Author filter with compact checkbox
        self.author_checkbox = QCheckBox('By author')
        self.author_checkbox.stateChanged.connect(self.apply_filters)
        layout.addWidget(self.author_checkbox)
        
        # Spoiler filter with compact checkbox
        self.hide_spoilers_checkbox = QCheckBox('Hide spoil')
        self.hide_spoilers_checkbox.setChecked(True)
        self.hide_spoilers_checkbox.stateChanged.connect(self.apply_filters)
        layout.addWidget(self.hide_spoilers_checkbox)
        
        # Sort by dropdown with compact label
        sort_label = QLabel('Sort:')
        sort_label.setMaximumWidth(35)
        layout.addWidget(sort_label)
        self.sort_combo = QComboBox()
        self.sort_combo.setMaximumHeight(25)
        self.sort_combo.addItems([
            'Name (A-Z)',
            'Name (Z-A)',
            'Downloads (High to Low)',
            'Downloads (Low to High)',
            'Comments (Most to Least)',
            'Comments (Least to Most)',
            'Date Created (Newest)',
            'Date Created (Oldest)',
            'Date Updated (Newest)',
            'Date Updated (Oldest)'
        ])
        self.sort_combo.currentIndexChanged.connect(self.apply_filters)
        layout.addWidget(self.sort_combo)
        
        widget.setLayout(layout)
        return widget
        
    def create_worlds_grid(self) -> QScrollArea:
        """Create the scrollable grid of world cards"""
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        
        # Container widget for the grid
        container = QWidget()
        self.grid_layout = QGridLayout()
        self.grid_layout.setSpacing(10)
        container.setLayout(self.grid_layout)
        
        scroll.setWidget(container)
        return scroll
        
    def create_details_panel(self) -> QWidget:
        """Create the world details panel"""
        widget = QWidget()
        layout = QVBoxLayout()
        
        # Title
        title_label = QLabel('World Details')
        title_label.setFont(QFont('Arial', 14, QFont.Weight.Bold))
        layout.addWidget(title_label)
        
        # Thumbnail
        self.detail_thumbnail = QLabel()
        self.detail_thumbnail.setFixedSize(300, 300)
        self.detail_thumbnail.setScaledContents(True)
        self.detail_thumbnail.setStyleSheet("background-color: #2a2a2a; border: 2px solid #444;")
        self.detail_thumbnail.setAlignment(Qt.AlignmentFlag.AlignCenter)
        layout.addWidget(self.detail_thumbnail)
        
        # World info text
        self.detail_text = QTextEdit()
        self.detail_text.setReadOnly(True)
        layout.addWidget(self.detail_text, stretch=1)
        
        # Action buttons
        btn_layout = QHBoxLayout()
        
        self.save_world_btn = QPushButton('Save World Data')
        self.save_world_btn.clicked.connect(self.save_world_data)
        self.save_world_btn.setEnabled(False)
        btn_layout.addWidget(self.save_world_btn)
        
        layout.addLayout(btn_layout)
        
        widget.setLayout(layout)
        return widget
        
    def open_snapshot(self):
        """Open a snapshot file"""
        file_path, _ = QFileDialog.getOpenFileName(
            self,
            'Open Snapshot File',
            '',
            'Snapshot Files (*.zip);;All Files (*.*)'
        )
        
        if not file_path:
            return
            
        try:
            # Close previous snapshot if open
            if self.snapshot_file:
                self.snapshot_file.close()
                
            # Open new snapshot
            self.snapshot_file = zipfile.ZipFile(file_path, 'r')
            self.snapshot_path = file_path
            
            # Read metadata
            with self.snapshot_file.open('worlds-metadata.json') as f:
                self.metadata = json.load(f)
                
            # Update UI
            snapshot_name = Path(file_path).name
            total_worlds = self.metadata['totalWorlds']
            
            self.statusBar().showMessage(f'Loaded {total_worlds} worlds')
            
            # Display all worlds initially
            self.filtered_worlds = self.metadata['worlds']
            self.display_worlds()
            
            # Remove the top bar entirely after successful load
            self.top_bar_widget.deleteLater()
            
        except Exception as e:
            QMessageBox.critical(self, 'Error', f'Failed to open snapshot:\n{str(e)}')
            
    def apply_filters(self):
        """Apply search and filter criteria"""
        if not self.metadata:
            return
            
        search_text = self.search_input.text().lower()
        tag_text = self.tag_input.text().lower()
        search_by_author = self.author_checkbox.isChecked()
        hide_spoilers = self.hide_spoilers_checkbox.isChecked()
        
        # Parse tags
        filter_tags = [tag.strip() for tag in tag_text.split(',') if tag.strip()]
        
        # Filter worlds
        self.filtered_worlds = []
        for world in self.metadata['worlds']:
            # Spoiler filter
            if hide_spoilers and world.get('spoiler', False):
                continue
                
            # Search filter
            if search_text:
                if search_by_author:
                    if search_text not in world['author']['username'].lower():
                        continue
                else:
                    if (search_text not in world['name'].lower() and
                        search_text not in world['description'].lower() and
                        not any(search_text in tag.lower() for tag in world['tags'])):
                        continue
                        
            # Tag filter
            if filter_tags:
                world_tags_lower = [tag.lower() for tag in world['tags']]
                if not any(filter_tag in world_tags_lower for filter_tag in filter_tags):
                    continue
                    
            self.filtered_worlds.append(world)
        
        # Apply sorting
        self.sort_worlds()
            
        self.display_worlds()
        self.statusBar().showMessage(
            f'Showing {len(self.filtered_worlds)} of {self.metadata["totalWorlds"]} worlds'
        )
        
    def sort_worlds(self):
        """Sort the filtered worlds based on selected sort option"""
        if not self.filtered_worlds:
            return
        
        sort_option = self.sort_combo.currentText()
        
        if sort_option == 'Name (A-Z)':
            self.filtered_worlds.sort(key=lambda w: w['name'].lower())
        elif sort_option == 'Name (Z-A)':
            self.filtered_worlds.sort(key=lambda w: w['name'].lower(), reverse=True)
        elif sort_option == 'Downloads (High to Low)':
            self.filtered_worlds.sort(key=lambda w: w['downloads'], reverse=True)
        elif sort_option == 'Downloads (Low to High)':
            self.filtered_worlds.sort(key=lambda w: w['downloads'])
        elif sort_option == 'Comments (Most to Least)':
            self.filtered_worlds.sort(key=lambda w: w['commentCount'], reverse=True)
        elif sort_option == 'Comments (Least to Most)':
            self.filtered_worlds.sort(key=lambda w: w['commentCount'])
        elif sort_option == 'Date Created (Newest)':
            self.filtered_worlds.sort(key=lambda w: w['createdAt'], reverse=True)
        elif sort_option == 'Date Created (Oldest)':
            self.filtered_worlds.sort(key=lambda w: w['createdAt'])
        elif sort_option == 'Date Updated (Newest)':
            self.filtered_worlds.sort(key=lambda w: w['updatedAt'], reverse=True)
        elif sort_option == 'Date Updated (Oldest)':
            self.filtered_worlds.sort(key=lambda w: w['updatedAt'])
    
    def display_worlds(self):
        """Display filtered worlds in the grid"""
        # Clear existing cards
        for card in self.world_cards:
            card.deleteLater()
        self.world_cards.clear()
        
        # Remove all widgets from grid
        while self.grid_layout.count():
            item = self.grid_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
                
        # Add new cards
        columns = 3
        for i, world in enumerate(self.filtered_worlds):
            row = i // columns
            col = i % columns
            
            card = WorldCard(world)
            card.clicked.connect(self.show_world_details)
            self.world_cards.append(card)
            self.grid_layout.addWidget(card, row, col)
            
            # Load thumbnail asynchronously
            self.load_thumbnail_for_card(card, world)
            
        # Add stretch to push cards to top
        self.grid_layout.setRowStretch(len(self.filtered_worlds) // columns + 1, 1)
        
    def load_thumbnail_for_card(self, card: WorldCard, world: Dict):
        """Load thumbnail for a world card"""
        try:
            folder_name = world['folderName']
            
            # Find thumbnail file in the world folder
            thumbnail_files = [
                name for name in self.snapshot_file.namelist()
                if name.startswith(f"{folder_name}/thumbnail")
            ]
            
            if thumbnail_files:
                thumbnail_data = self.snapshot_file.read(thumbnail_files[0])
                pixmap = self.load_pixmap_from_bytes(thumbnail_data)
                card.set_thumbnail(pixmap)
            else:
                card.set_thumbnail(None)
                
        except Exception as e:
            print(f"Error loading thumbnail for {world['name']}: {e}")
            card.set_thumbnail(None)
            
    def load_pixmap_from_bytes(self, image_data: bytes) -> Optional[QPixmap]:
        """Load a QPixmap from image bytes"""
        try:
            image = QImage()
            if image.loadFromData(image_data):
                return QPixmap.fromImage(image)
        except Exception as e:
            print(f"Error loading image: {e}")
        return None
    
    def load_world_comments(self, world: Dict) -> str:
        """Load and format comments for a world"""
        try:
            folder_name = world['folderName']
            comments_file = f"{folder_name}/comments.json"
            
            # Check if comments file exists
            if comments_file not in self.snapshot_file.namelist():
                return "<hr><h3>Comments</h3><p><i>No comments available</i></p>"
            
            # Read comments
            comments_data = self.snapshot_file.read(comments_file)
            comments_json = json.loads(comments_data)
            
            total_comments = comments_json.get('totalComments', 0)
            comments = comments_json.get('comments', [])
            
            if total_comments == 0 or not comments:
                return "<hr><h3>Comments</h3><p><i>No comments yet</i></p>"
            
            # Format comments as HTML
            comments_html = f"<hr><h3>Comments ({total_comments})</h3>"
            
            for comment in comments:
                author = comment.get('author', {}).get('username', 'Unknown')
                content = comment.get('content', '').replace('\n', '<br>')
                created_at = comment.get('createdAt', '')
                
                # Format date to be more readable if available
                if created_at:
                    try:
                        from datetime import datetime
                        dt = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
                        date_str = dt.strftime('%Y-%m-%d %H:%M')
                    except:
                        date_str = created_at
                else:
                    date_str = 'Unknown date'
                
                comments_html += f"""
                <div style="background-color: #1a1a1a; padding: 10px; margin: 10px 0; border-left: 3px solid #42a5f5;">
                    <p style="margin: 0; color: #42a5f5;"><b>{author}</b> <span style="color: #666; font-size: 0.9em;">• {date_str}</span></p>
                    <p style="margin: 5px 0 0 0;">{content}</p>
                </div>
                """
            
            return comments_html
            
        except Exception as e:
            print(f"Error loading comments: {e}")
            return "<hr><h3>Comments</h3><p><i>Error loading comments</i></p>"
    
    def show_world_details(self, world: Dict):
        """Display detailed information about a world"""
        self.current_world = world
        
        # Load thumbnail
        try:
            folder_name = world['folderName']
            thumbnail_files = [
                name for name in self.snapshot_file.namelist()
                if name.startswith(f"{folder_name}/thumbnail")
            ]
            
            if thumbnail_files:
                thumbnail_data = self.snapshot_file.read(thumbnail_files[0])
                pixmap = self.load_pixmap_from_bytes(thumbnail_data)
                if pixmap:
                    scaled_pixmap = pixmap.scaled(
                        300, 300,
                        Qt.AspectRatioMode.KeepAspectRatio,
                        Qt.TransformationMode.SmoothTransformation
                    )
                    self.detail_thumbnail.setPixmap(scaled_pixmap)
                else:
                    self.detail_thumbnail.setText("No Thumbnail")
            else:
                self.detail_thumbnail.clear()
                self.detail_thumbnail.setText("No Thumbnail")
                
        except Exception as e:
            self.detail_thumbnail.clear()
            self.detail_thumbnail.setText("Error Loading Thumbnail")
            print(f"Error loading thumbnail: {e}")
            
        # Load and display comments
        comments_html = self.load_world_comments(world)
        
        # Display world information
        tags_str = ', '.join(world['tags']) if world['tags'] else 'None'
        spoiler_str = '⚠️ SPOILER' if world.get('spoiler', False) else 'No'
        
        details = f"""
<h2>{world['name']}</h2>
<p><b>Author:</b> {world['author']['username']}</p>
<p><b>Description:</b><br>{world['description']}</p>
<p><b>Tags:</b> {tags_str}</p>
<p><b>Downloads:</b> {world['downloads']}</p>
<p><b>Comments:</b> {world['commentCount']}</p>
<p><b>Spoiler:</b> {spoiler_str}</p>
<p><b>Created:</b> {world['createdAt']}</p>
<p><b>Updated:</b> {world['updatedAt']}</p>
<p><b>World ID:</b> {world['id']}</p>

{comments_html}
"""
        
        self.detail_text.setHtml(details)
        
        # Enable action buttons
        self.save_world_btn.setEnabled(True)
        
    def save_world_data(self):
        """Save the current world's JSON data to a file"""
        if not self.current_world:
            return
            
        world = self.current_world
        safe_name = "".join(c for c in world['name'] if c.isalnum() or c in (' ', '-', '_'))
        default_name = f"{safe_name}.json"
        
        file_path, _ = QFileDialog.getSaveFileName(
            self,
            'Save World Data',
            default_name,
            'JSON Files (*.json);;All Files (*.*)'
        )
        
        if not file_path:
            return
            
        try:
            folder_name = world['folderName']
            content_file = f"{folder_name}/content.json"
            
            # Extract world content
            world_data = self.snapshot_file.read(content_file)
            
            # Save to file
            with open(file_path, 'wb') as f:
                f.write(world_data)
                
            QMessageBox.information(
                self,
                'Success',
                f'World data saved to:\n{file_path}'
            )
            
        except Exception as e:
            QMessageBox.critical(
                self,
                'Error',
                f'Failed to save world data:\n{str(e)}'
            )
            
    def save_thumbnail(self):
        """Save the current world's thumbnail to a file"""
        if not self.current_world:
            return
            
        world = self.current_world
        safe_name = "".join(c for c in world['name'] if c.isalnum() or c in (' ', '-', '_'))
        
        try:
            folder_name = world['folderName']
            thumbnail_files = [
                name for name in self.snapshot_file.namelist()
                if name.startswith(f"{folder_name}/thumbnail")
            ]
            
            if not thumbnail_files:
                QMessageBox.warning(self, 'No Thumbnail', 'This world has no thumbnail.')
                return
                
            # Get file extension
            ext = Path(thumbnail_files[0]).suffix
            default_name = f"{safe_name}_thumbnail{ext}"
            
            file_path, _ = QFileDialog.getSaveFileName(
                self,
                'Save Thumbnail',
                default_name,
                f'Image Files (*{ext});;All Files (*.*)'
            )
            
            if not file_path:
                return
                
            # Extract and save thumbnail
            thumbnail_data = self.snapshot_file.read(thumbnail_files[0])
            with open(file_path, 'wb') as f:
                f.write(thumbnail_data)
                
            QMessageBox.information(
                self,
                'Success',
                f'Thumbnail saved to:\n{file_path}'
            )
            
        except Exception as e:
            QMessageBox.critical(
                self,
                'Error',
                f'Failed to save thumbnail:\n{str(e)}'
            )
            
    def closeEvent(self, event):
        """Clean up when closing the application"""
        if self.snapshot_file:
            self.snapshot_file.close()
        event.accept()


def main():
    app = QApplication(sys.argv)
    
    # Set dark theme
    app.setStyle('Fusion')
    from PyQt6.QtGui import QPalette, QColor
    
    dark_palette = QPalette()
    dark_palette.setColor(QPalette.ColorRole.Window, QColor(53, 53, 53))
    dark_palette.setColor(QPalette.ColorRole.WindowText, Qt.GlobalColor.white)
    dark_palette.setColor(QPalette.ColorRole.Base, QColor(25, 25, 25))
    dark_palette.setColor(QPalette.ColorRole.AlternateBase, QColor(53, 53, 53))
    dark_palette.setColor(QPalette.ColorRole.ToolTipBase, Qt.GlobalColor.white)
    dark_palette.setColor(QPalette.ColorRole.ToolTipText, Qt.GlobalColor.white)
    dark_palette.setColor(QPalette.ColorRole.Text, Qt.GlobalColor.white)
    dark_palette.setColor(QPalette.ColorRole.Button, QColor(53, 53, 53))
    dark_palette.setColor(QPalette.ColorRole.ButtonText, Qt.GlobalColor.white)
    dark_palette.setColor(QPalette.ColorRole.BrightText, Qt.GlobalColor.red)
    dark_palette.setColor(QPalette.ColorRole.Link, QColor(42, 130, 218))
    dark_palette.setColor(QPalette.ColorRole.Highlight, QColor(42, 130, 218))
    dark_palette.setColor(QPalette.ColorRole.HighlightedText, Qt.GlobalColor.black)
    
    app.setPalette(dark_palette)
    
    viewer = SnapshotViewer()
    viewer.show()
    sys.exit(app.exec())


if __name__ == '__main__':
    main()
