const express = require('express');
const pool = require('../../db');
const {
    authenticateToken,
    requirePermission
} = require('../middleware/auth');

const router = express.Router();

// تقرير إحصائيات الجودة
router.get(
    '/',
    authenticateToken,
    requirePermission('QUALITY_MANAGE'),
    async (req, res) => {
        try {
            const { from, to } = req.query;

            const inspectionParams = [];
            const inspectionConditions = [];

            if (from) {
                inspectionParams.push(from);
                inspectionConditions.push(
                    `inspected_at >= $${inspectionParams.length}::date`
                );
            }

            if (to) {
                inspectionParams.push(to);
                inspectionConditions.push(
                    `inspected_at < ($${inspectionParams.length}::date + INTERVAL '1 day')`
                );
            }

            const inspectionWhere = inspectionConditions.length
                ? `WHERE ${inspectionConditions.join(' AND ')}`
                : '';

            const inspections = await pool.query(`
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE result = 'PASSED') AS passed,
                    COUNT(*) FILTER (WHERE result = 'FAILED') AS failed,
                    COUNT(*) FILTER (WHERE result = 'PENDING') AS pending
                FROM quality_inspections
                ${inspectionWhere}
            `, inspectionParams);

            const correctiveParams = [];
            const correctiveConditions = [];

            if (from) {
                correctiveParams.push(from);
                correctiveConditions.push(
                    `created_at >= $${correctiveParams.length}::date`
                );
            }

            if (to) {
                correctiveParams.push(to);
                correctiveConditions.push(
                    `created_at < ($${correctiveParams.length}::date + INTERVAL '1 day')`
                );
            }

            const correctiveWhere = correctiveConditions.length
                ? `WHERE ${correctiveConditions.join(' AND ')}`
                : '';

            const nonconformity = await pool.query(`
                SELECT
                    COUNT(*) FILTER (WHERE workmanship_result = 'FAILED') AS workmanship_failed,
                    COUNT(*) FILTER (WHERE material_result = 'FAILED') AS material_failed,
                    COUNT(*) FILTER (WHERE appearance_result = 'FAILED') AS appearance_failed,
                    COUNT(*) FILTER (WHERE function_result = 'FAILED') AS function_failed,
                    COUNT(*) FILTER (WHERE customer_requirements_result = 'FAILED') AS customer_requirements_failed
                FROM quality_inspections
                ${inspectionWhere}
            `, inspectionParams);

            const corrective = await pool.query(`
                SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE status = 'OPEN') AS open,
                    COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
                    COUNT(*) FILTER (
                        WHERE status = 'OPEN'
                        AND due_date IS NOT NULL
                        AND due_date < CURRENT_DATE
                    ) AS overdue
                FROM corrective_actions
                ${correctiveWhere}
            `, correctiveParams);

            const result = inspections.rows[0];
            const correctiveResult = corrective.rows[0];
            const nonconformityResult = nonconformity.rows[0];

            let comparison = null;

            if (from && to) {
                const currentFrom = new Date(from + 'T00:00:00Z');
                const currentTo = new Date(to + 'T00:00:00Z');

                const durationMs =
                    currentTo.getTime() - currentFrom.getTime();

                const previousTo = new Date(
                    currentFrom.getTime() - 24 * 60 * 60 * 1000
                );

                const previousFrom = new Date(
                    previousTo.getTime() - durationMs
                );

                const previousFromDate =
                    previousFrom.toISOString().slice(0, 10);

                const previousToDate =
                    previousTo.toISOString().slice(0, 10);

                const previousInspections = await pool.query(`
                    SELECT
                        COUNT(*) AS total,
                        COUNT(*) FILTER (WHERE result = 'PASSED') AS passed,
                        COUNT(*) FILTER (WHERE result = 'FAILED') AS failed
                    FROM quality_inspections
                    WHERE inspected_at >= $1::date
                      AND inspected_at < ($2::date + INTERVAL '1 day')
                `, [previousFromDate, previousToDate]);

                const previousResult = previousInspections.rows[0];

                const previousTotal = Number(previousResult.total);
                const previousPassed = Number(previousResult.passed);
                const previousFailed = Number(previousResult.failed);

                const previousPassRate = previousTotal
                    ? Number(((previousPassed / previousTotal) * 100).toFixed(2))
                    : 0;

                const previousFailRate = previousTotal
                    ? Number(((previousFailed / previousTotal) * 100).toFixed(2))
                    : 0;

                comparison = {
                    current_period: {
                        from,
                        to,
                        pass_rate: Number(
                            ((Number(result.passed) / Number(result.total || 1)) * 100).toFixed(2)
                        ),
                        fail_rate: Number(
                            ((Number(result.failed) / Number(result.total || 1)) * 100).toFixed(2)
                        )
                    },
                    previous_period: {
                        from: previousFromDate,
                        to: previousToDate,
                        total: previousTotal,
                        passed: previousPassed,
                        failed: previousFailed,
                        pass_rate: previousPassRate,
                        fail_rate: previousFailRate
                    },
                    change: {
                        pass_rate: Number(
                            (
                                (
                                    (Number(result.passed) / Number(result.total || 1)) * 100
                                ) - previousPassRate
                            ).toFixed(2)
                        ),
                        fail_rate: Number(
                            (
                                (
                                    (Number(result.failed) / Number(result.total || 1)) * 100
                                ) - previousFailRate
                            ).toFixed(2)
                        )
                    }
                };
            }

            const total = Number(result.total);
            const passed = Number(result.passed);
            const failed = Number(result.failed);

            const passRate = total
                ? Number(((passed / total) * 100).toFixed(2))
                : 0;

            const failRate = total
                ? Number(((failed / total) * 100).toFixed(2))
                : 0;

            res.json({
                success: true,
                data: {
                    inspections: {
                        total,
                        passed,
                        failed,
                        pending: Number(result.pending),
                        pass_rate: passRate,
                        fail_rate: failRate
                    },
                    corrective_actions: {
                        total: Number(correctiveResult.total),
                        open: Number(correctiveResult.open),
                        completed: Number(correctiveResult.completed),
                        overdue: Number(correctiveResult.overdue)
                    },
                    nonconformity_analysis: {
                        workmanship_failed: Number(nonconformityResult.workmanship_failed),
                        material_failed: Number(nonconformityResult.material_failed),
                        appearance_failed: Number(nonconformityResult.appearance_failed),
                        function_failed: Number(nonconformityResult.function_failed),
                        customer_requirements_failed: Number(nonconformityResult.customer_requirements_failed)
                    },
                    period_comparison: comparison
                }
            });

        } catch (error) {
            console.error('Quality reports error:', error);

            res.status(500).json({
                success: false,
                message: 'تعذر تحميل تقرير الجودة'
            });
        }
    }
);

module.exports = router;
