// Loads the vendored ApexGrid module (js/vendor/apex-grid/, all local files) and registers <apex-grid>.
// Include with <script type="module" src="../js/widgets/apex-grid-loader.js"></script>; ApexRender waits on ApexGridReady.
import { ApexGrid } from '../vendor/apex-grid/apex-grid.js';
ApexGrid.register();
window.ApexGrid = ApexGrid;
dispatchEvent(new Event('apexgrid-ready'));
