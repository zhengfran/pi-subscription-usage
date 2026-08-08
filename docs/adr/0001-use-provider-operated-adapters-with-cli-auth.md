# Use provider-operated adapters with existing CLI authentication

The package will read subscription usage through isolated provider adapters that reuse authentication established by each provider's official CLI. It may call undocumented, read-only provider-operated endpoints when no stable public usage API exists; it will neither own credentials nor fabricate a replacement when an upstream contract breaks, accepting adapter maintenance in exchange for account-wide coverage.
