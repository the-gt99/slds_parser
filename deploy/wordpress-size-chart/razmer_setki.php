<div id="table-sizes" aria-hidden="true" class="popup">
    <div class="popup__wrapper">
        <div class="popup__content search-size">
            <?php if(empty($tables)){
            ?>

            Для этого товара нет таблицы размеров

            <?php } else {?>
            <div class="search-size__header">
                <div class="search-size__title">Таблица размеров</div>
                <button data-close type="button" class="popup__close search-size__close">
                    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M24 0C10.8 0 0 10.8 0 24C0 37.2 10.8 48 24 48C37.2 48 48 37.2 48 24C48 10.8 37.2 0 24 0ZM24 43.2C13.44 43.2 4.8 34.56 4.8 24C4.8 13.44 13.44 4.8 24 4.8C34.56 4.8 43.2 13.44 43.2 24C43.2 34.56 34.56 43.2 24 43.2Z"
                              fill="#171717"/>
                        <path d="M32.64 12L24 20.64L15.36 12L12 15.36L20.64 24L12 32.64L15.36 36L24 27.36L32.64 36L36 32.64L27.36 24L36 15.36L32.64 12Z"
                              fill="#171717"/>
                    </svg>
                </button>
            </div>

            <?php if (count($tables) > 1) { ?>
                <div class="size-chart__selection">
                    <label for="product-size-chart-choice">Размерная сетка</label>
                    <select class="size-chart-choice" id="product-size-chart-choice" data-size-chart-choice aria-controls="product-size-chart-panels">
                        <option value="">Выберите бренд и раздел</option>
                        <?php foreach ($tables as $chart_index => $chart) { ?>
                            <option value="<?= (int) $chart_index ?>"><?= htmlspecialchars($chart['label'], ENT_QUOTES, 'UTF-8') ?></option>
                        <?php } ?>
                    </select>
                </div>
                <noscript>Для выбора размерной сетки включите JavaScript.</noscript>
            <?php } ?>
            <div class="size-chart" id="product-size-chart-panels">
                <div class="size-chart__container">
                    <?php foreach ($tables as $chart_index => $table) { ?>
                        <div class="size-chart__table" data-size-chart-panel="<?= (int) $chart_index ?>"<?= count($tables) > 1 ? ' hidden style="display:none"' : '' ?>>
                            <div data-tabs data-tabs-animate="500" class="size-chart__tabs">
                                <div data-tabs-body class="size-chart__content">
                                    <?php //foreach ($table['sections'] as $section) { ?>
                                        <div class="size-chart__body body-size-chart">
                                            <div data-tabs data-tabs-animate="500" class="body-size-chart__tabs">
                                                <div data-tabs-body class="body-size-chart__content">
                                                    <?php include "razmer_setka_body.php"?>
                                                </div>
                                            </div>
                                        </div>
                                    <?php //} ?>
                                </div>
                            </div>
                        </div>
                    <?php } ?>
                </div>
            </div>
        <?php } ?>
        </div>
    </div>
</div>
<script src="/wp-content/themes/slds/single_product/size-chart-choice.js?v=20260916-2" defer></script>
