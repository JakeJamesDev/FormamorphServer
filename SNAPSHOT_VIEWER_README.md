# Formamorph World Snapshot Viewer

A PyQt6 desktop application for browsing and extracting worlds from snapshot files without unpacking the entire archive.

## Features

- **Browse snapshots** without extracting the entire ZIP file
- **Search and filter** worlds by name, description, tags, or author
- **View thumbnails** loaded directly from the ZIP archive
- **Hide spoiler** worlds with a checkbox filter
- **View detailed information** about each world
- **Export individual worlds** - save world JSON data and thumbnails
- **Dark theme** UI for comfortable viewing
- **Grid layout** with world cards showing thumbnails and stats

## Installation

### Prerequisites

- Python 3.8 or higher
- pip (Python package installer)

### Install Dependencies

Run the following command in the project directory:

```bash
pip install -r requirements.txt
```

Or install PyQt6 directly:

```bash
pip install PyQt6
```

### For Development/Source Installation

If you want to install from source or in a virtual environment:

```bash
# Create a virtual environment (optional but recommended)
python -m venv venv

# Activate virtual environment
# On Windows:
venv\Scripts\activate
# On macOS/Linux:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

## Usage

### Running the Application

Simply run the Python script:

```bash
python snapshot_viewer.py
```

Or make it executable (Unix/Linux/macOS):

```bash
chmod +x snapshot_viewer.py
./snapshot_viewer.py
```

### Using the Viewer

1. **Open a Snapshot**
   - Click "Open Snapshot" button
   - Select a `.zip` snapshot file
   - The viewer will load the metadata and display all worlds

2. **Search and Filter**
   - **Search**: Enter text to search in world names, descriptions, or tags
   - **Tags**: Filter by specific tags (comma-separated)
   - **Search by author**: Check this to search by author username instead
   - **Hide spoilers**: Hide worlds marked as spoilers

3. **Browse Worlds**
   - Worlds are displayed as cards in a grid
   - Each card shows:
     - Thumbnail image
     - World name
     - Author username
     - Download count and comment count
   - Click any card to view full details

4. **View World Details**
   - Click a world card to see detailed information
   - View larger thumbnail
   - See full description, tags, stats, and dates
   - Access export buttons

5. **Export World Data**
   - **Save World Data**: Export the world's JSON file
   - **Save Thumbnail**: Export the world's thumbnail image
   - Choose save location and filename

## UI Overview

```
┌─────────────────────────────────────────────────────────────┐
│ [Open Snapshot] Snapshot: example.zip | 42 worlds           │
├─────────────────────────────────────────────────────────────┤
│ Search: [________] Tags: [_______] □ By author  ☑ Hide spoil│
├─────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────┬────────────────────────────┤
│ │ World Grid (Scrollable)      │ World Details              │
│ │ ┌───┐ ┌───┐ ┌───┐           │ ┌──────────┐              │
│ │ │img│ │img│ │img│            │ │  Large   │              │
│ │ │   │ │   │ │   │            │ │  Thumb   │              │
│ │ └───┘ └───┘ └───┘            │ └──────────┘              │
│ │ Name  Name  Name             │ Description...            │
│ │ byAuthor                      │ Tags: adventure, combat   │
│ │ ↓50 💬5                        │ Author: username          │
│ │                               │ Downloads: 150            │
│ │ ┌───┐ ┌───┐ ┌───┐           │ Created: 2025-01-01       │
│ │ │img│ │img│ │img│            │                           │
│ │ └───┘ └───┘ └───┘            │ [Save World] [Save Thumb] │
│ └──────────────────────────────┴────────────────────────────┤
│ Status: Showing 10 of 42 worlds                             │
└─────────────────────────────────────────────────────────────┘
```

## Features Explained

### Efficient ZIP Reading

The viewer reads the snapshot ZIP file without extracting everything:

1. **Metadata Loading**: Only reads `worlds-metadata.json` initially
2. **On-Demand Thumbnails**: Loads thumbnails only for visible worlds
3. **Lazy Content Loading**: World content is only read when exporting

This makes the viewer fast even with large snapshots containing many worlds.

### Search and Filtering

- **Name/Description Search**: Searches through world names and descriptions
- **Tag Search**: Searches within world tags
- **Author Search**: Filter by author username (enable checkbox)
- **Multiple Tags**: Use comma-separated tags to filter by multiple tags
- **Spoiler Filter**: Hide worlds marked as spoilers

### World Cards

Each world card displays:
- Thumbnail image (180x180px)
- World name
- Author username
- Download count (↓ icon)
- Comment count (💬 icon)

### Details Panel

Shows comprehensive world information:
- Large thumbnail (300x300px)
- Full description
- All tags
- Author information
- Download and comment statistics
- Spoiler warning
- Creation and update dates
- World UUID

## Keyboard Shortcuts

- The application uses standard Qt shortcuts:
  - `Ctrl+Q` / `Alt+F4`: Quit application
  - Standard text editing shortcuts work in search fields

## Technical Details

### Dependencies

- **PyQt6**: Modern Qt6 bindings for Python
  - QtWidgets: UI components
  - QtCore: Core functionality
  - QtGui: Graphics and imaging

### Architecture

- **WorldCard**: Custom widget for world display cards
- **SnapshotViewer**: Main window with search, filtering, and display logic
- **Efficient memory usage**: Only loads necessary data from ZIP
- **Dark theme**: Custom palette for comfortable viewing

### File Format Support

The viewer works with snapshot files created by the Node.js server:
- Reads `worlds-metadata.json` for world listing
- Accesses individual `world-[id]/` folders for details
- Supports various image formats for thumbnails (JPG, PNG, etc.)

## Troubleshooting

### Application won't start

1. Check Python version: `python --version` (requires 3.8+)
2. Verify PyQt6 installation: `pip list | grep PyQt6`
3. Try reinstalling: `pip install --upgrade PyQt6`

### Can't open snapshot file

1. Ensure the file is a valid ZIP file
2. Verify it contains `worlds-metadata.json`
3. Check file permissions

### Thumbnails not loading

- Thumbnails load lazily; scroll to trigger loading
- Some worlds may not have thumbnails (shows "No Thumbnail")
- Check console output for any error messages

### Performance issues

- Large snapshots (100+ worlds) may take a moment to load thumbnails
- Try filtering to reduce visible worlds
- Close and reopen the application if memory usage is high

## Limitations

- Cannot edit world data (view and export only)
- No built-in import to server functionality
- Cannot create new snapshots (use Node.js server for that)
- Single snapshot open at a time

## Future Enhancements

Potential improvements:
- Multi-snapshot comparison
- Bulk export functionality
- Comments viewer
- World statistics and analytics
- Thumbnail caching for faster reloading
- Multiple selection for batch export
- Custom sorting options
- Save favorite worlds

## Contributing

To modify or extend the viewer:

1. The code is well-commented and organized
2. Main components:
   - `WorldCard`: Individual world card widget
   - `SnapshotViewer`: Main application window
   - UI creation methods: `create_*()` functions
   - Event handlers: `on_*()` or specific action methods

## Support

For issues or questions:
1. Check this README for solutions
2. Review the SNAPSHOT_DOCUMENTATION.md for snapshot format details
3. Ensure your snapshot was created with the Node.js server

## License

This tool is part of the Formamorph World Workshop Server project.
