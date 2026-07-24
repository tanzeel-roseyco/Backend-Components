# Python components

This directory contains nine independent Python components. They cover rate
limiting, exchange request signing, market-data access, trading indicators and
signals, trade journalling, HTTP resilience, signed tokens, and immutable
configuration.

There is no repository-level Python package or requirements file. Read the
README beside a component before using it. That file names the imports and data
shape used by the source. Install only the dependencies needed by the selected
component.

The components are intended to be copied into another project and adapted at
their external boundaries. They do not provide exchange credentials, databases,
market data, or a deployed API.

No repository-wide Python test command is currently provided. An adopting
project should add focused tests for the component under its own supported
Python version and dependency set.
