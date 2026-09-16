<?php //foreach ($section['clothing_type'] as $clothing_type) { ?>
    <div class="body-size-chart__body">
        <?php //if (!empty($clothing_type['table'])) {
        //$clothing_type['table']
            $header_count = count($table['header']);
            $header_count = $header_count < 2 ? 2 : $header_count;
            ?>
            <style>
                #product-size-chart-panels [data-size-chart-panel="<?= (int) $chart_index ?>"] .body-size-chart__row span {
                    flex: 0 0 <?= 100 / $header_count ?>% !important;
                }
            </style>
            <div class="body-size-chart__table">
                <?php if (!empty($table['header'])) { ?>
                    <div class="body-size-chart__thead">
                        <div class="body-size-chart__row">
                            <?php foreach ($table['header'] as $header) { ?>
                                <span><?= $header['c'] ?></span>
                            <?php } ?>
                        </div>
                    </div>
                <?php } ?>
                <div class="body-size-chart__tbody">
                    <?php foreach ($table['body'] as $row) { ?>
                        <div class="body-size-chart__row">
                            <?php foreach ($row as $cell) { ?>
                                <span><?= $cell['c'] ?></span>
                            <?php } ?>
                        </div>
                    <?php } ?>
                </div>
            </div>
        <?php //} ?>
    </div>
<?php //}
